import { createHmac } from "node:crypto";
import { prisma } from "@admedic/database";
import { requireActor } from "../../../../_lib/auth";
import { respond, sameOrigin, HttpError } from "../../../../_lib/http";
import { z } from "zod";
export const maxDuration = 10;

const WebhookSchema = z.object({
  object: z.literal("page"),
  entry: z.array(
    z.object({
      id: z.string(),
      time: z.number(),
      changes: z.array(
        z.object({
          value: z.object({
            messaging: z.array(
              z.object({
                sender: z.object({
                  psid: z.string(),
                  phone_number: z.string().optional(),
                }),
                message: z.object({
                  text: z.string(),
                  attachments: z.array(z.object({ type: z.string() })).optional(),
                }).optional(),
                postback: z.object({ title: z.string() }).optional(),
                delivery: z.object({}).optional(),
                optin: z.object({}).optional(),
              }),
            ),
            lead_data: z.object({
              lead_id: z.string(),
              form_name: z.string().optional(),
              field_data: z.array(
                z.object({
                  name: z.string(),
                  values: z.array(z.string()),
                }),
              ).optional(),
            }).optional(),
          }),
        }),
      ),
    }),
  ),
}).strict();

function verifySignature(payload: string, signature: string | null): boolean {
  if (!signature) return false;
  const secret = process.env.META_WEBHOOK_SECRET ?? "";
  if (!secret) return true;
  const expected = "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
  return expected === signature.replace("sha256=", "");
}

export async function POST(request: Request) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    const raw = await request.text();
    const sig = request.headers.get("x-hub-signature-256");
    if (!verifySignature(raw, sig))
      throw new HttpError(401, "İmza doğrulanamadı.");
    const input = JSON.parse(raw);
    const parsed = WebhookSchema.safeParse(input);
    if (!parsed.success) throw new HttpError(400, "Geçersiz webhook verisi.");

    for (const entry of parsed.data.entry) {
      for (const change of entry.changes) {
        const value = change.value;
        const messages = value.messaging;
        if (!messages) continue;
        for (const msg of messages) {
          const phone = msg.sender.phone_number;
          if (!phone) continue;
          const existing = await prisma.lead.findFirst({
            where: { workspaceId: actor.workspaceId, phone },
          });
          if (existing) continue;
          const fieldData = value.lead_data?.field_data ?? [];
          const fields: Record<string, string> = {};
          for (const f of fieldData) {
            fields[f.name] = f.values.join(", ");
          }
          await prisma.lead.create({
            data: {
              workspaceId: actor.workspaceId,
              organizationId: actor.orgId,
              firstName: fields.first_name ?? "WhatsApp",
              lastName: fields.last_name ?? "",
              email: fields.email ?? null,
              phone,
              country: fields.country ?? null,
              language: fields.language ?? "tr",
              channel: "WHATSAPP",
              status: "NEW",
              metadata: {
                source: "whatsapp",
                form_name: value.lead_data?.form_name,
                fields,
              },
            },
          });
        }
      }
    }
    return { received: true };
  });
}

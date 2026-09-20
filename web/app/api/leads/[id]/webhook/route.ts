import { createHmac } from "node:crypto";
import { prisma } from "@admedic/database";
import { requireActor } from "../../../../_lib/auth";
import { respond, sameOrigin, HttpError } from "../../../../_lib/http";
import { z } from "zod";
export const maxDuration = 30;

const LeadWebhookSchema = z.object({
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  email: z.string().email().nullable().optional().default(null),
  phone: z.string().nullable().optional().default(null),
  country: z.string().nullable().optional(),
  language: z.string().optional(),
  channel: z.string().nullable().optional(),
  campaignId: z.string().nullable().optional(),
  adSetId: z.string().nullable().optional(),
  adId: z.string().nullable().optional(),
  metadata: z.record(z.any()).optional(),
}).strict();

function normalizePhone(phone: string | null): string | null {
  if (!phone) return null;
  return phone.replace(/[\s\-\(\)\+]/g, "").replace(/^0/, "");
}

function normalizeEmail(email: string | null): string | null {
  if (!email) return null;
  return email.trim().toLowerCase();
}

export async function POST(request: Request) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    const secret = process.env.META_WEBHOOK_SECRET ?? "placeholder-secret";
    const signature = request.headers.get("X-Hub-Signature-256");
    const payload = await request.text();
    if (secret && signature) {
      const expected = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
      if (!constantTimeEqual(signature, expected)) {
        throw new HttpError(403, "Webhook imzası doğrulanamadı.");
      }
    }
    const data = JSON.parse(payload) as Record<string, unknown>;
    const fieldData = (data as { field_data?: Array<{ name: string; values: string[] }> }).field_data ?? [];
    const fields: Record<string, string[]> = {};
    for (const fd of fieldData) {
      fields[fd.name] = fd.values;
    }
    const email = normalizeEmail(fields.email?.[0] ?? (data.email as string) ?? null);
    const phone = normalizePhone(fields.phone_number?.[0] ?? fields.phone?.[0] ?? (data.phone as string) ?? null);
    const leadData: Record<string, unknown> = {
      firstName: fields.full_name?.[0] ?? fields.first_name?.[0] ?? (data.firstName as string) ?? (data.first_name as string),
      lastName: fields.last_name?.[0] ?? (data.lastName as string) ?? (data.last_name as string),
      email,
      phone,
      country: fields.country?.[0] ?? (data.country as string) ?? undefined,
      language: fields.language?.[0] ?? (data.language as string) ?? undefined,
      channel: fields.channel?.[0] ?? (data.channel as string) ?? undefined,
      campaignId: fields.campaign_id?.[0] ?? (data.campaignId as string) ?? undefined,
      adSetId: fields.ad_set_id?.[0] ?? (data.adSetId as string) ?? undefined,
      adId: fields.ad_id?.[0] ?? (data.adId as string) ?? undefined,
      metadata: data.metadata ?? {},
    };
    const parsed = LeadWebhookSchema.parse(leadData);
    const existingLead = await prisma.lead.findFirst({
      where: {
        organizationId: actor.orgId,
        OR: [
          ...(parsed.phone ? [{ phone: parsed.phone }] : []),
          ...(parsed.email ? [{ email: parsed.email }] : []),
        ],
      },
    });
    if (existingLead) {
      return { ok: true, duplicateOf: existingLead.id };
    }
    const lead = await prisma.lead.create({
      data: {
        firstName: parsed.firstName,
        lastName: parsed.lastName,
        email: parsed.email,
        phone: parsed.phone,
        country: parsed.country,
        language: parsed.language ?? "tr",
        channel: parsed.channel,
        campaignId: parsed.campaignId,
        adSetId: parsed.adSetId,
        adId: parsed.adId,
        metadata: parsed.metadata as Record<string, any> ?? {},
        workspaceId: actor.workspaceId,
        organizationId: actor.orgId,
        status: "NEW",
      },
    });
    return { ok: true, lead };
  });
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

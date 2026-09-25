import { prisma } from "@admedic/database";
import { respond, HttpError } from "../../../../_lib/http";
import { z } from "zod";
import { encrypt } from "../../../../_lib/encrypt";
import { leadLookupHash } from "../../../../_lib/lead-hash";
import { verifyWebhookSignature } from "../../../../_lib/verify";
import { sendWhatsAppMessage } from "../../../../_lib/whatsapp";
import { AnthropicProvider } from "@admedic/llm";
import { loadEnv } from "@admedic/config";
export const maxDuration = 60;

let _aiProvider: AnthropicProvider | null = null;
function getAIProvider(): AnthropicProvider {
  if (!_aiProvider) {
    const env = loadEnv();
    _aiProvider = new AnthropicProvider(env.LLM_API_KEY ?? "", env.LLM_MODEL ?? "claude-sonnet-4");
  }
  return _aiProvider;
}

const GREETING_PROMPT = `Bir sağlık turizmi kliniğinin WhatsApp karşılama asistanı ol. Lead'in dilinde ({language}) kısa, sıcak ve profesyonel bir karşılama mesajı yaz. 300 karakteri geçme. Tıbbi tavsiye, teşhis veya fiyat verme. Sadece karşılama ve yardıma yönlendirme yap.`;

async function generateAIGreeting(language: string): Promise<string | null> {
  try {
    const provider = getAIProvider();
    const key = language === "ar" ? "AR" : language.toUpperCase() as "TR" | "EN" | "DE" | "RU" | "AR" | "FR" | "NL" | "PL";
    const result = await provider.generate({ clinic: "Klinik", service: "Sağlık Turizmi", market: "global", language: key as any, budget: 0, duration: 1 });
    return result.variants[0].text?.slice(0, 300) ?? null;
  } catch {
    return null;
  }
}

const WebhookSchema = z.object({
  object: z.literal("page"),
  entry: z.array(
    z.object({
      id: z.string(),
      time: z.number(),
      changes: z.array(
        z.object({
          value: z.object({
            messaging: z
              .array(
                z.object({
                  sender: z
                    .object({
                      id: z.string().optional(),
                      phone_number: z.string().optional(),
                    })
                    .optional(),
                  message: z
                    .object({
                      mid: z.string().optional(),
                      text: z.string().optional(),
                      is_echo: z.boolean().optional(),
                      attachments: z
                        .array(z.object({ type: z.string() }))
                        .optional(),
                    })
                    .optional(),
                  postback: z.object({ title: z.string() }).optional(),
                  delivery: z.object({}).optional(),
                  optin: z.object({}).optional(),
                }),
              )
              .optional(),
            leadgen_id: z.string().optional(),
            page_id: z.string().optional(),
            form_name: z.string().optional(),
            field_data: z
              .array(z.object({ name: z.string(), values: z.array(z.string()) }))
              .optional(),
          }),
        }),
      ),
    }),
  ),
}).strict();

function safeEncrypt(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  try {
    return encrypt(value);
  } catch {
    return null;
  }
}

function fieldsToRecord(
  fieldData: Array<{ name: string; values: string[] }>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fieldData) out[f.name] = f.values.join(", ");
  return out;
}

function normalizeField(value: Record<string, string>, ...keys: string[]): string | null {
  for (const k of keys) {
    if (value[k] && value[k].trim()) return value[k].trim();
  }
  return null;
}

async function ingestLeadGen(input: {
  leadgenId: string;
  formName: string | null;
  pageId: string;
  orgId: string;
  workspaceId: string;
  fields: Array<{ name: string; values: string[] }>;
}): Promise<number> {
  const fields = fieldsToRecord(input.fields);
  const email = normalizeField(fields, "email", "Email");
  const phone =
    normalizeField(fields, "phone_number", "phone", "Phone") ??
    normalizeField(fields, "telefon") ??
    null;
  const fullName = normalizeField(fields, "full_name", "Full Name") ?? "";
  const first = normalizeField(fields, "first_name") ?? fullName.split(" ")[0] ?? "Meta";
  const last =
    normalizeField(fields, "last_name") ??
    fullName.split(" ").slice(1).join(" ") ??
    "";
  const interestedService = normalizeField(
    fields,
    "interested_service",
    "service",
    "hizmet",
    "treatment",
    "treatment_name",
  );
  const hash = leadLookupHash({ orgId: input.orgId, phone, email });

  const existingById = await prisma.lead.findFirst({
    where: {
      organizationId: input.orgId,
      metadata: { path: ["leadgen_id"], equals: input.leadgenId },
    },
    select: { id: true },
  });
  if (existingById) return 0;

  const existingByHash = hash
    ? await prisma.lead.findFirst({
        where: { organizationId: input.orgId, lookupHash: hash },
        select: { id: true, metadata: true },
      })
    : null;
  if (existingByHash) {
    await prisma.lead.update({
      where: { id: existingByHash.id },
      data: {
        duplicateOf: existingByHash.id,
        metadata: {
          ...(existingByHash.metadata as Record<string, unknown>),
          leadgen_id: input.leadgenId,
        },
      },
    });
    return 0;
  }

  const lead = await prisma.lead.create({
    data: {
      workspaceId: input.workspaceId,
      organizationId: input.orgId,
      firstName: first,
      lastName: last,
      email: safeEncrypt(email),
      phone: safeEncrypt(phone),
      country: normalizeField(fields, "country_code", "country") ?? null,
      language: (normalizeField(fields, "language") ?? "tr").toLowerCase(),
      channel: "LEAD_AD",
      interestedService,
      status: "NEW",
      lookupHash: hash,
      metadata: {
        source: "lead_ads",
        leadgen_id: input.leadgenId,
        page_id: input.pageId,
        form_name: input.formName ?? null,
        fields,
      },
    },
  });
  await prisma.auditLog.create({
    data: {
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      action: "LEAD_INGESTED",
      entityType: "LEAD",
      entityId: lead.id,
      after: { source: "lead_ads", leadgen_id: input.leadgenId },
    },
  });
  return 1;
}

async function ingestMessaging(input: {
  msg: {
    sender?: { id?: string; phone_number?: string };
    message?: { mid?: string; text?: string; is_echo?: boolean };
  };
  pageId: string;
  orgId: string;
  workspaceId: string;
  isInstagram: boolean;
}): Promise<number> {
  const mid = input.msg.message?.mid;
  if (!mid || input.msg.message?.is_echo) return 0;
  const psid = input.msg.sender?.id ?? null;
  const phone = input.msg.sender?.phone_number ?? null;
  const hash = leadLookupHash({
    orgId: input.orgId,
    phone,
    psid,
    igId: input.isInstagram ? psid : undefined,
  });
  if (!hash) return 0;

  const existing = await prisma.lead.findFirst({
    where: {
      organizationId: input.orgId,
      metadata: { path: ["mid"], equals: mid },
    },
    select: { id: true },
  });
  if (existing) return 0;

  let lead = await prisma.lead.findFirst({
    where: { organizationId: input.orgId, lookupHash: hash },
    select: {
      id: true,
      metadata: true,
      channel: true,
      language: true,
      conversations: {
        where: { status: { in: ["ACTIVE", "ESCALATED"] } },
        take: 1,
        select: { id: true, channel: true },
      },
    },
  });

  const channel = input.isInstagram
    ? "INSTAGRAM"
    : phone
      ? "WHATSAPP"
      : "MESSENGER" as const;
  let conversationId = lead?.conversations[0]?.id ?? null;
  let metadata = lead?.metadata as Record<string, unknown> | null;
  let leadId = lead?.id ?? null;
  let leadLanguage = lead?.language ?? "tr";

  if (!lead) {
    const created = await prisma.lead.create({
      data: {
        workspaceId: input.workspaceId,
        organizationId: input.orgId,
        firstName: psid ? "Konuk" : "Meta",
        lastName: "",
        phone: safeEncrypt(phone),
        channel,
        status: "NEW",
        language: "tr",
        lookupHash: hash,
        metadata: { source: "messaging", psid, page_id: input.pageId },
      },
    });
    await prisma.auditLog.create({
      data: {
        orgId: input.orgId,
        workspaceId: input.workspaceId,
        action: "LEAD_INGESTED",
        entityType: "LEAD",
        entityId: created.id,
        after: { source: "messaging", mid },
      },
    });
    leadId = created.id;
    leadLanguage = created.language;
    metadata = created.metadata as Record<string, unknown>;
  }

  if (!leadId) return 0;

  if (!conversationId) {
    const conversation = await prisma.conversation.create({
      data: {
        leadId,
        workspaceId: input.workspaceId,
        channel,
        status: "ACTIVE",
        initiatedBy: "bot",
      },
    });
    conversationId = conversation.id;
    if (channel === "WHATSAPP") {
      const aiGreeting = await generateAIGreeting(leadLanguage);
      if (aiGreeting) {
        await prisma.message.create({
          data: {
            conversationId,
            direction: "OUTGOING",
            channel: "WHATSAPP",
            content: aiGreeting,
            sender: "bot",
            metadata: { autoGreet: true, source: "ai" },
          },
        });
      }
      const templateName = process.env.WHATSAPP_GREETING_TEMPLATE ?? "";
      if (templateName) {
        const greeting = await sendWhatsAppMessage(
          { phone, language: "tr" },
          "",
          templateName,
          {},
        );
        if (!greeting.error) {
          await prisma.message.create({
            data: {
              conversationId,
              direction: "OUTGOING",
              channel: "WHATSAPP",
              content: "(şablon karşılama)",
              sender: "bot",
              metadata: {
                whatsappTemplate: templateName,
                autoGreet: true,
                whatsappResult: { id: greeting.id ?? null, error: null },
              },
            },
          });
        }
      }
    }
  }

  await prisma.message.create({
    data: {
      conversationId,
      direction: "INCOMING",
      channel,
      content: input.msg.message?.text ?? "(ek içerik)",
      sender: psid ?? "external",
      metadata: { mid },
    },
  });
  await prisma.lead.update({
    where: { id: leadId },
    data: { metadata: { ...metadata, mid } },
  });
  return 1;
}

export async function POST(request: Request) {
  return respond(async () => {
    const raw = await request.text();
    const secret = process.env.META_WEBHOOK_SECRET;
    const signature = request.headers.get("x-hub-signature-256");
    if (!verifyWebhookSignature(raw, signature, secret))
      throw new HttpError(401, "Webhook imzası doğrulanamadı.");

    let input: unknown;
    try {
      input = JSON.parse(raw);
    } catch {
      throw new HttpError(400, "Geçersiz webhook gövdesi.");
    }
    const parsed = WebhookSchema.safeParse(input);
    if (!parsed.success)
      throw new HttpError(400, "Geçersiz webhook verisi.");

    let processed = 0;
    let ignoredPages = 0;

    for (const entry of parsed.data.entry) {
      const connection = await prisma.metaConnection.findFirst({
        where: {
          OR: [
            { pageId: entry.id },
            { instaId: entry.id },
          ],
        },
        select: { id: true, orgId: true, instaId: true },
      });
      if (!connection) {
        ignoredPages++;
        continue;
      }
      const workspace = await prisma.workspace.findFirst({
        where: { orgId: connection.orgId },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      });
      if (!workspace) continue;

      for (const change of entry.changes) {
        const value = change.value;
        if (value.leadgen_id) {
          processed += await ingestLeadGen({
            leadgenId: value.leadgen_id,
            formName: value.form_name ?? null,
            pageId: entry.id,
            orgId: connection.orgId,
            workspaceId: workspace.id,
            fields: value.field_data ?? [],
          });
        }
        for (const msg of value.messaging ?? []) {
          processed += await ingestMessaging({
            msg,
            pageId: entry.id,
            orgId: connection.orgId,
            workspaceId: workspace.id,
            isInstagram: connection.instaId === entry.id,
          });
        }
      }
    }

    return { received: true, processed, ignoredPages };
  });
}
import { prisma, AlertSeverity, AlertType, Prisma } from "@admedic/database";
import { getLlmConfig, tryDecryptField, type LlmConfig } from "@admedic/config";
import {
  appSecretProof,
  getGraphVersion,
  sendMessengerText,
  sendWhatsAppMessage,
  type WhatsAppTransport,
} from "@admedic/meta-api";
import {
  ASSISTANT_HISTORY_LIMIT,
  LEAD_ASSISTANT_PROMPT_VERSION,
  buildAssistantReply,
  callWithLog,
  detectHandoff,
  handoffNotice,
  leadAlias,
  normalizeLanguageCode,
  type AssistantHistoryItem,
  type HandoffReason,
  type LlmLogSink,
} from "@admedic/llm";

/**
 * Otomatik yanıt tetikleyicisi (spec 3.8): webhook (W2) gelen mesajı kaydeder ama bot yanıtı
 * üretmez; bu iş her zamanlayıcı turunda ACTIVE konuşmalarda son mesajı INCOMING olan ve
 * karşılamadan (`firstResponseAt`) sonra yanıtlanmamış konuşmaları bulup yanıt üretir.
 * Saf kısım `@admedic/llm` (buildAssistantReply, detectHandoff); DB + kanal gönderimi burada.
 * Web'deki `web/app/_lib/lead-assistant.ts` ile aynı sözleşme: OUTGOING sender "ai",
 * devirde ESCALATED + lead bilgilendirmesi + koordinatör Alert'i.
 */

export interface AssistantRunOptions {
  /** Test/override: LLM yapılandırması; verilmezse `getLlmConfig()`. */
  llm?: LlmConfig | null;
  /** LLM taşıyıcısı (test: mock fetch). */
  transport?: typeof fetch;
  senders?: {
    whatsapp?: typeof sendWhatsAppMessage;
    messenger?: typeof sendMessengerText;
  };
  /** Tur başına en fazla konuşma. */
  limit?: number;
  /** Yalnızca bu workspace (test/izolasyon). */
  workspaceId?: string;
}

export interface AssistantRunResult {
  replied: number;
  escalated: number;
  skipped: number;
  failed: number;
}

/** Aynı gelen mesaj için en fazla bu kadar LLM denemesi; sonra koordinatör uyarısı. */
export const ASSISTANT_MAX_ATTEMPTS = 3;
export const HANDOFF_ALERT_TYPE = AlertType.CONVERSATION_ESCALATED;
const HANDOFF_LABEL: Record<HandoffReason, string> = {
  emergency: "acil durum",
  human: "insan isteği",
  out_of_scope: "kapsam dışı soru (fiyat / tıbbi uygunluk)",
};

const llmLogSink: LlmLogSink = async (entry) => {
  await prisma.llmCallLog.create({
    data: {
      workspaceId: entry.workspaceId,
      agent: entry.agent,
      model: entry.model,
      promptVersion: entry.promptVersion,
      status: entry.status,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      durationMs: entry.durationMs,
    },
  });
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function isBotSender(sender: string | null): boolean {
  const s = (sender ?? "").trim().toLowerCase();
  return !s || s === "ai" || s === "bot";
}

/** Kronolojik geçmiş: INCOMING → lead, bot → assistant, sistem notu atlanır, insan → team. */
export function toHistory(
  messages: Array<{ direction: string; sender: string | null; content: string }>,
): AssistantHistoryItem[] {
  const out: AssistantHistoryItem[] = [];
  for (const m of [...messages].reverse()) {
    if (m.direction === "INCOMING") out.push({ role: "lead", text: m.content });
    else if ((m.sender ?? "").trim().toLowerCase() === "system") continue;
    else out.push({ role: isBotSender(m.sender) ? "assistant" : "team", text: m.content });
  }
  return out;
}

/**
 * Adaylar: ACTIVE, karşılanmış (`firstResponseAt`) ve son mesajı karşılamadan sonra gelen
 * INCOMING olan konuşmalar (en eski bekleyen önce). Son mesaj koşulu SQL'de (LATERAL) uygulanır
 * ki yanıtlanmış konuşmalar tur limitini doldurmasın. 24 saatlik mesajlaşma penceresi dışında
 * kalan gelen mesajlara serbest metin gönderilemez (WhatsApp şablon / Messenger HUMAN_AGENT
 * kuralı); onlar koordinatöre bırakılır.
 */
async function findCandidates(options: AssistantRunOptions) {
  const limit = options.limit ?? 50;
  const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT c.id
    FROM "Conversation" c
    JOIN LATERAL (
      SELECT m.direction, m."createdAt"
      FROM "Message" m
      WHERE m."conversationId" = c.id
      ORDER BY m."createdAt" DESC
      LIMIT 1
    ) last ON true
    WHERE c.status = 'ACTIVE'
      AND c."firstResponseAt" IS NOT NULL
      AND last.direction = 'INCOMING'
      AND last."createdAt" > c."firstResponseAt"
      AND last."createdAt" > now() - interval '24 hours'
      ${options.workspaceId ? Prisma.sql`AND c."workspaceId" = ${options.workspaceId}` : Prisma.empty}
    ORDER BY last."createdAt" ASC
    LIMIT ${limit}
  `);
  if (rows.length === 0) return [];
  const order = new Map(rows.map((r, i) => [r.id, i]));
  const conversations = await prisma.conversation.findMany({
    where: { id: { in: rows.map((r) => r.id) } },
    include: {
      lead: { select: { id: true, organizationId: true, language: true, phone: true, metadata: true } },
      messages: { orderBy: { createdAt: "desc" }, take: ASSISTANT_HISTORY_LIMIT },
    },
  });
  return conversations
    .filter((c) => {
      const last = c.messages[0];
      if (!last || last.direction !== "INCOMING") return false;
      const attempts = Number(asRecord(last.metadata).assistantAttempts ?? 0);
      return attempts < ASSISTANT_MAX_ATTEMPTS;
    })
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}
type Candidate = Awaited<ReturnType<typeof findCandidates>>[number];

async function deliver(
  conversation: Candidate,
  text: string,
  options: AssistantRunOptions,
): Promise<{ id: string | null; error: string | null }> {
  const lead = conversation.lead;
  if (conversation.channel === "WHATSAPP") {
    const send = options.senders?.whatsapp ?? sendWhatsAppMessage;
    const transport = await resolveWhatsAppTransport(lead.organizationId);
    const result = await send({ phone: tryDecryptField(lead.phone), language: lead.language, transport }, text);
    return { id: result.id ?? null, error: result.error ?? null };
  }
  if (conversation.channel === "MESSENGER" || conversation.channel === "INSTAGRAM") {
    const send = options.senders?.messenger ?? sendMessengerText;
    const meta = asRecord(lead.metadata);
    const pageId = typeof meta.page_id === "string" ? meta.page_id : null;
    const isInstagram = conversation.channel === "INSTAGRAM";
    const connection = await prisma.metaConnection.findFirst({
      where: {
        orgId: lead.organizationId,
        status: "CONNECTED",
        tokenCiphertext: { not: null },
        ...(pageId
          ? isInstagram
            ? { OR: [{ instaId: pageId }, { pageId }] }
            : { pageId }
          : isInstagram
            ? { instaId: { not: null } }
            : { pageId: { not: null } }),
      },
      orderBy: { updatedAt: "desc" },
      select: { pageId: true, instaId: true, tokenCiphertext: true },
    });
    const result = await send({
      token: tryDecryptField(connection?.tokenCiphertext),
      targetId: isInstagram ? (connection?.instaId ?? null) : (connection?.pageId ?? null),
      psid: typeof meta.psid === "string" ? meta.psid : null,
      text,
    });
    return { id: result.id ?? null, error: result.error ?? null };
  }
  return { id: null, error: "SMS kanalı için gönderim bağlantısı henüz yapılandırılmadı." };
}

async function finalizeOutgoing(
  messageId: string,
  metadata: Record<string, unknown>,
  result: { id: string | null; error: string | null },
): Promise<void> {
  await prisma.message.update({
    where: { id: messageId },
    data: {
      metadata: {
        ...metadata,
        pendingSend: false,
        providerResult: result,
        ...(result.error ? { deliveryError: result.error } : {}),
      } as Prisma.InputJsonObject,
    },
  });
}

/** Kısa transaction: danışma kilidi altında konuşma hâlâ ACTIVE ve son mesaj aynıysa OUTGOING yazar; değilse null. */
async function claimReply(
  conversation: Candidate,
  lastInboundId: string,
  text: string,
  metadata: Record<string, unknown>,
  escalation: { reason: HandoffReason } | null,
): Promise<string | null> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${conversation.id}), hashtext('assistant'))`;
    const current = await tx.conversation.findUnique({
      where: { id: conversation.id },
      select: { status: true, messages: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true } } },
    });
    if (current?.status !== "ACTIVE" || current.messages[0]?.id !== lastInboundId) return null;
    if (escalation) {
      await tx.conversation.update({
        where: { id: conversation.id },
        data: { status: "ESCALATED", escalatedTo: null, escalatedAt: new Date() },
      });
      await tx.alert.create({
        data: {
          workspaceId: conversation.workspaceId,
          type: HANDOFF_ALERT_TYPE,
          severity: escalation.reason === "emergency" ? AlertSeverity.CRITICAL : AlertSeverity.INFO,
          title:
            escalation.reason === "emergency"
              ? "Acil durum: asistan konuşmayı devretti"
              : "Asistan konuşmayı koordinatöre devretti",
          message: `Otomatik asistan ${conversation.channel} konuşmasını durdurdu (${HANDOFF_LABEL[escalation.reason]}). Bir hasta koordinatörü devralmalı.`,
          entityType: "CONVERSATION",
          entityId: conversation.id,
        },
      });
      await tx.auditLog.create({
        data: {
          orgId: conversation.lead.organizationId,
          workspaceId: conversation.workspaceId,
          userId: null,
          action: "CONVERSATION_ESCALATED",
          entityType: "CONVERSATION",
          entityId: conversation.id,
          before: { status: "ACTIVE" },
          after: { status: "ESCALATED", auto: true, by: "assistant", reason: escalation.reason, inboundMessageId: lastInboundId },
        },
      });
    }
    const message = await tx.message.create({
      data: {
        conversationId: conversation.id,
        direction: "OUTGOING",
        channel: conversation.channel,
        content: text,
        sender: "ai",
        metadata: metadata as Prisma.InputJsonObject,
      },
      select: { id: true },
    });
    return message.id;
  });
}

/** LLM denemesi başarısız: gelen mesajda deneme sayısı artar; sınırda koordinatör uyarısı. */
async function recordFailure(conversation: Candidate, inbound: Candidate["messages"][number]): Promise<void> {
  const meta = asRecord(inbound.metadata);
  const attempts = Number(meta.assistantAttempts ?? 0) + 1;
  await prisma.message.update({
    where: { id: inbound.id },
    data: { metadata: { ...meta, assistantAttempts: attempts } as Prisma.InputJsonObject },
  });
  if (attempts < ASSISTANT_MAX_ATTEMPTS) return;
  await prisma.alert.create({
    data: {
      workspaceId: conversation.workspaceId,
      type: HANDOFF_ALERT_TYPE,
      severity: AlertSeverity.INFO,
      title: "Asistan yanıt üretemedi",
      message: `Otomatik asistan ${conversation.channel} konuşmasındaki son mesaja ${attempts} denemede yanıt üretemedi; koordinatör yanıtlamalı.`,
      entityType: "CONVERSATION",
      entityId: conversation.id,
    },
  });
}

async function handleConversation(
  conversation: Candidate,
  llm: LlmConfig | null,
  options: AssistantRunOptions,
): Promise<"replied" | "escalated" | "skipped" | "failed"> {
  const inbound = conversation.messages[0]!;
  const language = normalizeLanguageCode(conversation.lead.language);
  const handoff = detectHandoff(inbound.content, language);
  if (handoff.reason) {
    const text = handoffNotice(language, handoff.reason);
    const metadata = { autoReply: true, handoff: handoff.reason, pendingSend: true };
    const messageId = await claimReply(conversation, inbound.id, text, metadata, { reason: handoff.reason });
    if (!messageId) return "skipped";
    await finalizeOutgoing(messageId, metadata, await deliver(conversation, text, options));
    return "escalated";
  }
  if (!llm) return "skipped";
  const [clinic, org, alias] = await Promise.all([
    prisma.clinicProfile.findFirst({
      where: { workspaceId: conversation.workspaceId, status: "ACTIVE" },
      orderBy: { createdAt: "asc" },
      select: {
        name: true,
        languages: true,
        brandTone: true,
        services: { where: { status: "ACTIVE" }, select: { name: true }, take: 20 },
      },
    }),
    prisma.organization.findUnique({
      where: { id: conversation.lead.organizationId },
      select: { consentText: true },
    }),
    leadAlias(conversation.lead.organizationId, conversation.lead.id),
  ]);
  const firstBotMessage = !conversation.messages.some((m) => m.direction === "OUTGOING" && isBotSender(m.sender));
  let text: string;
  try {
    const reply = await callWithLog({
      workspaceId: conversation.workspaceId,
      agent: "lead-assistant",
      promptVersion: LEAD_ASSISTANT_PROMPT_VERSION,
      model: llm.model,
      sink: llmLogSink,
      run: () =>
        buildAssistantReply(
          {
            history: toHistory(conversation.messages),
            language,
            alias,
            channel: conversation.channel,
            clinic: clinic
              ? {
                  name: clinic.name,
                  services: clinic.services.map((s) => s.name),
                  languages: clinic.languages,
                  brandTone: clinic.brandTone,
                }
              : null,
            consentText: org?.consentText ?? null,
            firstBotMessage,
          },
          llm,
          options.transport,
        ),
    });
    text = reply.text;
  } catch {
    await recordFailure(conversation, inbound);
    return "failed";
  }
  const metadata = { autoReply: true, promptVersion: LEAD_ASSISTANT_PROMPT_VERSION, pendingSend: true };
  const messageId = await claimReply(conversation, inbound.id, text, metadata, null);
  if (!messageId) return "skipped";
  await finalizeOutgoing(messageId, metadata, await deliver(conversation, text, options));
  return "replied";
}

export async function runAssistant(options: AssistantRunOptions = {}): Promise<AssistantRunResult> {
  const llm = options.llm === undefined ? getLlmConfig() : options.llm;
  const result: AssistantRunResult = { replied: 0, escalated: 0, skipped: 0, failed: 0 };
  for (const conversation of await findCandidates(options)) {
    try {
      result[await handleConversation(conversation, llm, options)]++;
    } catch (err) {
      // PII yok: yalnızca konuşma kimliği ve hata sınıfı.
      console.warn(`[assistant] konuşma ${conversation.id} işlenemedi: ${err instanceof Error ? err.name : "hata"}`);
      result.failed++;
    }
  }
  return result;
}


/** Tenant'ın WhatsApp Cloud API hedefi (MetaConnection.whatsappPhoneNumberId + şifreli token); yoksa null → ortam düzeyi. */
async function resolveWhatsAppTransport(orgId: string): Promise<WhatsAppTransport | null> {
  const connection = await prisma.metaConnection.findFirst({
    where: {
      orgId,
      status: { in: ["CONNECTED", "DEGRADED"] },
      whatsappPhoneNumberId: { not: null },
      tokenCiphertext: { not: null },
    },
    orderBy: [{ type: "asc" }, { updatedAt: "desc" }],
    select: { whatsappPhoneNumberId: true, tokenCiphertext: true },
  });
  if (!connection?.whatsappPhoneNumberId) return null;
  const token = tryDecryptField(connection.tokenCiphertext);
  if (!token) return null;
  try {
    return {
      apiUrl: `https://graph.facebook.com/${getGraphVersion()}/${connection.whatsappPhoneNumberId}`,
      token,
      // Bağlantı token'ı bu uygulamanın OAuth akışından gelir → `appsecret_proof` geçerlidir.
      appsecretProof: appSecretProof(token) ?? null,
    };
  } catch {
    return null;
  }
}

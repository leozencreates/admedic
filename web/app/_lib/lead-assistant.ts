import { prisma, AlertSeverity, AlertType, type Prisma } from "@admedic/database";
import { getLlmConfig, LLM_NOT_CONFIGURED_MESSAGE } from "@admedic/config";
import {
  buildAssistantReply,
  detectHandoff,
  handoffNotice,
  leadAlias,
  normalizeLanguageCode,
  ASSISTANT_HISTORY_LIMIT,
  LEAD_ASSISTANT_PROMPT_VERSION,
  type AssistantHistoryItem,
  type HandoffReason,
} from "@admedic/llm";
import { BOT_DISCLOSURE } from "./webhook-ingest";
import { tryDecryptField } from "./encrypt";
import { sendWhatsAppMessage, WINDOW_MS } from "./whatsapp";
import { resolveWhatsAppTransport } from "./whatsapp-tenant";
import { sendMessengerMessage } from "./messenger";
import { withLlmLog } from "./llm-log";
import { HttpError } from "./http";
import { asRecord } from "./lead-view";
import { channelLabel } from "./labels";

/**
 * AI karşılama ve nitelendirme asistanı (spec 3.8): ACTIVE konuşmadaki son gelen mesaja
 * bot yanıtı üretir, kanaldan gönderir ve OUTGOING (sender "ai") kaydeder. Acil durum,
 * insan isteği ve kapsam dışı (fiyat/tıbbi uygunluk) tespitinde konuşma ESCALATED olur,
 * lead'e kendi dilinde kısa bilgilendirme gider ve koordinatör için Alert açılır.
 * Lead adı/telefon/e-posta prompta girmez: takma kimlik + serbest metin maskeleme.
 */

export interface RespondOptions {
  workspaceId: string;
  /** Eski sözleşme: panelden simüle edilen gelen mesaj; INCOMING olarak `simulated` işaretiyle kaydedilir. */
  simulatedInbound?: { text: string; recordedBy: string };
  /** Devir kaydında (escalatedTo/audit) görünecek kullanıcı; worker'da null. */
  actorUserId?: string | null;
}

export interface RespondResult {
  conversationId: string;
  escalated: boolean;
  reason: HandoffReason | null;
  /** Gönderilen metin (bot yanıtı ya da devir bilgilendirmesi). */
  reply: string;
  delivered: boolean;
  messageId: string;
}

export const HANDOFF_ALERT_TYPE = AlertType.CONVERSATION_ESCALATED;
const HANDOFF_LABEL: Record<HandoffReason, string> = {
  emergency: "acil durum",
  human: "insan isteği",
  out_of_scope: "kapsam dışı soru (fiyat / tıbbi uygunluk)",
};

type ConversationRow = NonNullable<Awaited<ReturnType<typeof loadConversation>>>;

async function loadConversation(conversationId: string, workspaceId: string) {
  return prisma.conversation.findFirst({
    where: { id: conversationId, workspaceId },
    include: {
      lead: {
        select: {
          id: true,
          organizationId: true,
          language: true,
          phone: true,
          metadata: true,
        },
      },
      messages: { orderBy: { createdAt: "desc" }, take: ASSISTANT_HISTORY_LIMIT },
    },
  });
}

function isBotSender(sender: string | null): boolean {
  const s = (sender ?? "").trim().toLowerCase();
  return !s || s === "ai" || s === "bot";
}

/** Kronolojik geçmiş (son 10): INCOMING → lead, bot → assistant, sistem notu atlanır, insan → team. */
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

/** Kanal gönderimi: WhatsApp (şifreli telefon), Messenger/Instagram (psid + page_id); mock modda mock. */
async function deliver(
  conversation: ConversationRow,
  text: string,
  options?: { simulated?: boolean },
): Promise<{ id: string | null; error: string | null }> {
  // Personel simülasyonu (/api/ai/chat `message` ile): yanıt yalnızca kayda geçer, gerçek lead'e
  // hiçbir kanaldan gönderilmez; 24 saat penceresi de gerçek gelen mesaja göre değerlendirilmez.
  if (options?.simulated) return { id: null, error: null };
  const lead = conversation.lead;
  if (conversation.channel === "WHATSAPP") {
    const result = await sendWhatsAppMessage(
      {
        phone: tryDecryptField(lead.phone),
        language: lead.language,
        transport: await resolveWhatsAppTransport(lead.organizationId),
      },
      text,
    );
    return { id: result.id ?? null, error: result.error ?? null };
  }
  if (conversation.channel === "MESSENGER" || conversation.channel === "INSTAGRAM") {
    const meta = asRecord(lead.metadata);
    const result = await sendMessengerMessage({
      orgId: lead.organizationId,
      channel: conversation.channel,
      psid: typeof meta.psid === "string" ? meta.psid : null,
      pageId: typeof meta.page_id === "string" ? meta.page_id : null,
      text,
    });
    return { id: result.id ?? null, error: result.error ?? null };
  }
  return { id: null, error: "SMS gönderimi henüz desteklenmiyor. Hastaya WhatsApp ya da e-postayla ulaşın." };
}

async function finalizeOutgoing(
  conversationId: string,
  messageId: string,
  metadata: Record<string, unknown>,
  result: { id: string | null; error: string | null },
): Promise<boolean> {
  const delivered = !result.error;
  await prisma.$transaction(async (tx) => {
    await tx.message.update({
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
    if (delivered)
      await tx.conversation.updateMany({
        where: { id: conversationId, firstResponseAt: null },
        data: { firstResponseAt: new Date() },
      });
  });
  return delivered;
}

async function escalate(
  conversation: ConversationRow,
  lastInboundId: string,
  reason: HandoffReason,
  options: RespondOptions,
): Promise<RespondResult> {
  const language = normalizeLanguageCode(conversation.lead.language);
  const text = handoffNotice(language, reason);
  const metadata = { autoReply: true, handoff: reason, pendingSend: true };
  const messageId = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${conversation.id}), hashtext('assistant'))`;
    const current = await tx.conversation.findUnique({
      where: { id: conversation.id },
      select: { status: true },
    });
    if (current?.status !== "ACTIVE")
      throw new HttpError(409, "Asistan durduruldu; konuşmayı koordinatör devraldı. Yanıtı konuşma ekranından elle gönderin.");
    const now = new Date();
    await tx.conversation.update({
      where: { id: conversation.id },
      data: { status: "ESCALATED", escalatedTo: options.actorUserId ?? null, escalatedAt: now },
    });
    const message = await tx.message.create({
      data: {
        conversationId: conversation.id,
        direction: "OUTGOING",
        channel: conversation.channel,
        content: text,
        sender: "ai",
        metadata,
      },
      select: { id: true },
    });
    // Devredilen konuşma bir insanın eylemini bekler: acil durum Kritik, diğer devirler Önemli (Faz 1).
    await tx.alert.create({
      data: {
        workspaceId: conversation.workspaceId,
        type: HANDOFF_ALERT_TYPE,
        severity: reason === "emergency" ? AlertSeverity.CRITICAL : AlertSeverity.WARNING,
        title:
          reason === "emergency"
            ? "Acil durum: asistan konuşmayı devretti"
            : "Asistan konuşmayı koordinatöre devretti",
        message: `Otomatik asistan ${channelLabel(conversation.channel)} konuşmasını durdurdu (${HANDOFF_LABEL[reason]}). Bir hasta koordinatörü devralmalı.`,
        entityType: "CONVERSATION",
        entityId: conversation.id,
      },
    });
    await tx.auditLog.create({
      data: {
        orgId: conversation.lead.organizationId,
        workspaceId: conversation.workspaceId,
        userId: options.actorUserId ?? null,
        action: "CONVERSATION_ESCALATED",
        entityType: "CONVERSATION",
        entityId: conversation.id,
        before: { status: "ACTIVE" },
        after: { status: "ESCALATED", auto: true, by: "assistant", reason, inboundMessageId: lastInboundId },
      },
    });
    return message.id;
  });
  const result = await deliver(conversation, text, { simulated: Boolean(options.simulatedInbound) });
  const delivered = await finalizeOutgoing(conversation.id, messageId, metadata, result);
  return { conversationId: conversation.id, escalated: true, reason, reply: text, delivered, messageId };
}

/**
 * Konuşmadaki son gelen mesaja yanıt üretir ve gönderir. Konuşma ESCALATED/CLOSED ise 409;
 * son mesaj zaten yanıtlanmışsa 409; LLM yapılandırılmamışsa (devir dışı) 503.
 */
export async function respondToInbound(conversationId: string, options: RespondOptions): Promise<RespondResult> {
  let conversation = await loadConversation(conversationId, options.workspaceId);
  if (!conversation) throw new HttpError(404, "Konuşma bulunamadı; silinmiş olabilir. Lead'ler sayfasından yeniden açın.");
  if (conversation.status !== "ACTIVE")
    throw new HttpError(409, "Bu konuşmada asistan durduruldu; koordinatör devralmalı.");
  if (options.simulatedInbound) {
    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        direction: "INCOMING",
        channel: conversation.channel,
        content: options.simulatedInbound.text,
        sender: "simulated",
        metadata: { simulated: true, recordedBy: options.simulatedInbound.recordedBy },
      },
    });
    conversation = (await loadConversation(conversationId, options.workspaceId)) ?? conversation;
  }
  const last = conversation.messages[0];
  if (!last || last.direction !== "INCOMING")
    throw new HttpError(409, "Yanıtlanacak yeni gelen mesaj yok. Hastadan yeni mesaj geldiğinde tekrar deneyin.");
  // 24 saatlik pencere (spec 3.8): pencere dışında serbest metin gönderilemez; koordinatör şablon kullanır.
  if (Date.now() - last.createdAt.getTime() > WINDOW_MS)
    throw new HttpError(409, "24 saatlik mesajlaşma penceresi dışında; koordinatör şablon mesajıyla devam etmeli.");

  const language = normalizeLanguageCode(conversation.lead.language);
  const handoff = detectHandoff(last.content, language);
  if (handoff.reason) return escalate(conversation, last.id, handoff.reason, options);

  const llm = getLlmConfig();
  if (!llm) throw new HttpError(503, LLM_NOT_CONFIGURED_MESSAGE);
  const history = toHistory(conversation.messages);
  const [clinic, org, alias, botMessages] = await Promise.all([
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
    // İlk bot mesajı mı? (karşılama dahil; spec 3.8 "bot olduğunu ilk mesajda belirtir")
    prisma.message.count({
      where: { conversationId: conversation.id, direction: "OUTGOING", sender: { in: ["bot", "ai"] } },
    }),
  ]);
  const firstBotMessage = botMessages === 0;
  const reply = await withLlmLog({
    workspaceId: conversation.workspaceId,
    agent: "lead-assistant",
    promptVersion: LEAD_ASSISTANT_PROMPT_VERSION,
    model: llm.model,
    run: () =>
      buildAssistantReply(
        {
          history,
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
      ),
  });
  const disclosure = BOT_DISCLOSURE[language.toLowerCase() as keyof typeof BOT_DISCLOSURE] ?? BOT_DISCLOSURE.tr;
  const text = firstBotMessage ? `${reply.text}\n\n${disclosure}` : reply.text;
  const metadata = { autoReply: true, promptVersion: LEAD_ASSISTANT_PROMPT_VERSION, pendingSend: true };

  // Kısa transaction: koordinatör bu arada devralmış ya da yeni mesaj gelmişse yazma (409).
  const messageId = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${conversation.id}), hashtext('assistant'))`;
    const current = await tx.conversation.findUnique({
      where: { id: conversation.id },
      select: { status: true, messages: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true } } },
    });
    if (current?.status !== "ACTIVE")
      throw new HttpError(409, "Asistan durduruldu; konuşmayı koordinatör devraldı. Yanıtı konuşma ekranından elle gönderin.");
    if (current.messages[0]?.id !== last.id)
      throw new HttpError(409, "Konuşma bu arada değişti. Yanıtı yeniden üretin.");
    const message = await tx.message.create({
      data: {
        conversationId: conversation.id,
        direction: "OUTGOING",
        channel: conversation.channel,
        content: text,
        sender: "ai",
        metadata,
      },
      select: { id: true },
    });
    return message.id;
  });
  const result = await deliver(conversation, text, { simulated: Boolean(options.simulatedInbound) });
  const delivered = await finalizeOutgoing(conversation.id, messageId, metadata, result);
  return { conversationId: conversation.id, escalated: false, reason: null, reply: text, delivered, messageId };
}

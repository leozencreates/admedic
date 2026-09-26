import { prisma } from "@admedic/database";
import type { Conversation, Lead, MessageChannel, MessageDirection, Prisma } from "@admedic/database";
import {
  requireActor,
  requireRole,
  CARE_ROLES,
  ESCALATION_ROLES,
  type Actor,
} from "../../../../_lib/auth";
import { body, respond, sameOrigin, HttpError } from "../../../../_lib/http";
import { z } from "zod";
import { tryDecryptField } from "../../../../_lib/encrypt";
import {
  sendWhatsAppMessage,
  normalizeTemplateName,
  WINDOW_MS,
} from "../../../../_lib/whatsapp";
import { resolveWhatsAppTransport } from "../../../../_lib/whatsapp-tenant";
import { sendMessengerMessage } from "../../../../_lib/messenger";
import { logAudit } from "../../../../_lib/audit";
import { asRecord } from "../../../../_lib/lead-view";
export const maxDuration = 15;

const MESSAGE_CHANNELS = ["WHATSAPP", "INSTAGRAM", "MESSENGER", "SMS"] as const;
const SendMessageSchema = z.object({
  content: z.string().trim().max(4000).optional().default(""),
  direction: z.enum(["OUTGOING"]).optional().default("OUTGOING"),
  /** Boş bırakılırsa konuşmanın kanalı kullanılır. */
  channel: z.enum(MESSAGE_CHANNELS).optional(),
  templateName: z.string().max(512).optional(),
  templateParams: z.record(z.string()).optional(),
}).strict();

type ConversationWithLead = Conversation & { lead: Lead };

function toMessageChannel(value: string | null | undefined, fallback: MessageChannel): MessageChannel {
  return (MESSAGE_CHANNELS as readonly string[]).includes(value ?? "")
    ? (value as MessageChannel)
    : fallback;
}

/**
 * `[id]` hem konuşma hem lead kimliği olabilir: önce konuşma aranır; bulunamazsa
 * lead'in en son ACTIVE/ESCALATED konuşması (yoksa en son konuşması) döner.
 * `create` verildiğinde açık konuşması olmayan lead için lead kanalıyla yeni konuşma açılır.
 */
async function resolveConversation(
  id: string,
  actor: Actor,
  options: { create?: boolean; channelHint?: MessageChannel } = {},
): Promise<ConversationWithLead | null> {
  const byId = await prisma.conversation.findFirst({
    where: { id, lead: { workspaceId: actor.workspaceId } },
    include: { lead: true },
  });
  if (byId) return byId;
  const lead = await prisma.lead.findFirst({ where: { id, workspaceId: actor.workspaceId } });
  if (!lead) return null;
  const open = await prisma.conversation.findFirst({
    where: { leadId: lead.id, status: { in: ["ACTIVE", "ESCALATED"] } },
    orderBy: { createdAt: "desc" },
    include: { lead: true },
  });
  if (open) return open;
  if (!options.create) {
    return prisma.conversation.findFirst({
      where: { leadId: lead.id },
      orderBy: { createdAt: "desc" },
      include: { lead: true },
    });
  }
  return prisma.conversation.create({
    data: {
      leadId: lead.id,
      workspaceId: actor.workspaceId,
      channel: toMessageChannel(lead.channel, options.channelHint ?? "WHATSAPP"),
      status: "ACTIVE",
      initiatedBy: actor.userId,
    },
    include: { lead: true },
  });
}

/**
 * 24 saat penceresi yalnızca gerçekten dış kanaldan gelen mesajlarla açılır:
 * INCOMING + (externalId ya da metadata.mid/wamid dolu ya da sender="external").
 * Panelden simüle edilen (sender = kullanıcı kimliği) gelen mesajlar sayılmaz.
 */
async function lastRealInboundAt(conversationId: string): Promise<Date | null> {
  const row = await prisma.message.findFirst({
    where: {
      conversationId,
      direction: "INCOMING",
      OR: [
        { externalId: { not: null } },
        { sender: "external" },
        { metadata: { path: ["mid"], string_starts_with: "" } },
        { metadata: { path: ["wamid"], string_starts_with: "" } },
      ],
    },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  return row?.createdAt ?? null;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return respond(async () => {
    const actor = await requireActor();
    const { id } = await params;
    const conversation = await resolveConversation(id, actor);
    if (!conversation) throw new HttpError(404, "Konuşma bulunamadı.");
    const messages = await prisma.message.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: "asc" },
      take: 100,
    });
    return {
      conversation: {
        id: conversation.id,
        leadId: conversation.leadId,
        channel: conversation.channel,
        status: conversation.status,
        escalatedTo: conversation.escalatedTo,
        messages,
      },
    };
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, CARE_ROLES);
    const { id } = await params;
    const input = await body(request, SendMessageSchema);
    const conversation = await resolveConversation(id, actor, {
      create: true,
      channelHint: input.channel,
    });
    if (!conversation) throw new HttpError(404, "Konuşma bulunamadı.");
    if (conversation.status === "CLOSED")
      throw new HttpError(409, "Kapalı konuşmaya mesaj gönderilemez.");
    // Devralınmış konuşmada yalnızca OWNER/ADMIN/PATIENT_COORDINATOR yazabilir.
    if (conversation.status === "ESCALATED") requireRole(actor, ESCALATION_ROLES);

    const channel = input.channel ?? conversation.channel;
    if (channel !== conversation.channel)
      throw new HttpError(422, "Mesaj kanalı konuşma kanalıyla eşleşmelidir.");
    if (channel === "SMS")
      throw new HttpError(422, "SMS kanalı için gönderim bağlantısı henüz yapılandırılmadı.");

    const rawTemplate = input.templateName?.trim() ?? "";
    const templateName = rawTemplate ? normalizeTemplateName(rawTemplate) : null;
    if (rawTemplate && !templateName)
      throw new HttpError(422, "Geçersiz şablon adı: yalnızca küçük harf, rakam ve alt çizgi kullanılabilir.");
    if (templateName && channel !== "WHATSAPP")
      throw new HttpError(422, "Şablon mesajı yalnızca WhatsApp kanalında gönderilebilir.");
    const isTemplate = templateName !== null;
    if (!isTemplate && !input.content)
      throw new HttpError(400, "Alanları kontrol edin; boş, fazla uzun veya geçersiz değerler var.");

    const lastInbound = await lastRealInboundAt(conversation.id);
    const withinWindow =
      lastInbound !== null && Date.now() - lastInbound.getTime() <= WINDOW_MS;
    if (channel === "WHATSAPP" && !isTemplate && !withinWindow)
      throw new HttpError(
        400,
        "24 saatlik mesajlaşma penceresi dışındasınız; serbest metin gönderilemez. Şablon mesajı (templateName) kullanın.",
      );

    const lead = conversation.lead;
    const leadMeta = asRecord(lead.metadata);
    const content = input.content || `(şablon: ${templateName})`;
    const providerResult =
      channel === "WHATSAPP"
        ? await sendWhatsAppMessage(
            {
              phone: tryDecryptField(lead.phone),
              language: lead.language,
              transport: await resolveWhatsAppTransport(actor.orgId),
            },
            content,
            templateName,
            input.templateParams ?? {},
          )
        : await sendMessengerMessage({
            orgId: actor.orgId,
            channel,
            psid: typeof leadMeta.psid === "string" ? leadMeta.psid : null,
            pageId: typeof leadMeta.page_id === "string" ? leadMeta.page_id : null,
            text: content,
            // Messenger/Instagram'da pencere dışı gönderim HUMAN_AGENT etiketi ister.
            humanAgent: !withinWindow,
          });
    if (providerResult.error) throw new HttpError(400, providerResult.error);

    const now = new Date();
    const takeover = conversation.status === "ACTIVE";
    const metadata: Prisma.InputJsonObject =
      channel === "WHATSAPP"
        ? {
            whatsappTemplate: templateName,
            whatsappTemplateParams: input.templateParams ?? {},
            whatsappResult: { id: providerResult.id ?? null, error: null },
          }
        : {
            messengerResult: { id: providerResult.id ?? null, error: null },
            humanAgentTag: !withinWindow,
          };
    const result = await prisma.$transaction(async (tx) => {
      const message = await tx.message.create({
        data: {
          conversationId: conversation.id,
          direction: (input.direction ?? "OUTGOING") as MessageDirection,
          channel,
          content,
          sender: actor.userId,
          metadata,
        },
      });
      const conversationUpdate: Prisma.ConversationUpdateInput = {};
      if (!conversation.firstResponseAt) conversationUpdate.firstResponseAt = now;
      if (takeover) {
        // İlk insan gönderimi = otomatik devralma; asistan bu konuşmada susar (spec 3.8).
        conversationUpdate.status = "ESCALATED";
        conversationUpdate.escalatedTo = actor.userId;
        conversationUpdate.escalatedAt = now;
      }
      const updated =
        Object.keys(conversationUpdate).length > 0
          ? await tx.conversation.update({
              where: { id: conversation.id },
              data: conversationUpdate,
              select: { status: true, escalatedTo: true },
            })
          : { status: conversation.status, escalatedTo: conversation.escalatedTo };
      if (takeover) {
        await logAudit({
          actor,
          action: "CONVERSATION_ESCALATED",
          entityType: "CONVERSATION",
          entityId: conversation.id,
          before: { status: "ACTIVE" },
          after: { status: "ESCALATED", auto: true, messageId: message.id },
        }, tx);
      }
      await logAudit({
        actor,
        action: "MESSAGE_SENT",
        entityType: "CONVERSATION",
        entityId: conversation.id,
        after: {
          channel,
          template: templateName,
          messageId: message.id,
          humanAgentTag: channel !== "WHATSAPP" && !withinWindow,
        },
      }, tx);
      return { message, status: updated.status, escalatedTo: updated.escalatedTo };
    });
    return {
      message: {
        id: result.message.id,
        content: result.message.content,
        direction: result.message.direction,
        channel: result.message.channel,
        sender: result.message.sender,
        createdAt: result.message.createdAt,
      },
      conversation: {
        id: conversation.id,
        status: result.status,
        escalatedTo: result.escalatedTo,
        takenOver: takeover,
      },
    };
  });
}

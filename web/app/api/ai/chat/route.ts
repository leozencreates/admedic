import { prisma, type MessageChannel } from "@admedic/database";
import { requireActor, requireRole, ESCALATION_ROLES } from "../../../_lib/auth";
import { body, respond, sameOrigin, HttpError } from "../../../_lib/http";
import { respondToInbound } from "../../../_lib/lead-assistant";
import { z } from "zod";

export const maxDuration = 60;

/**
 * AI asistan yanıtı (spec 3.8): konuşmadaki son GELEN mesaja bot yanıtı üretir, kanaldan
 * gönderir ve OUTGOING (sender "ai") kaydeder. `message` verilirse eski sözleşme korunur:
 * metin, lead'den gelmiş gibi simüle edilen INCOMING (sender "simulated") olarak kaydedilir
 * ve ona yanıt üretilir — personel metni lead mesajı sayılmaz.
 */
const ChatSchema = z
  .object({
    leadId: z.string().min(1),
    message: z.string().trim().min(1).max(4000).optional(),
    conversationId: z.string().optional(),
  })
  .strict();

const MESSAGE_CHANNELS = ["WHATSAPP", "INSTAGRAM", "MESSENGER", "SMS"] as const;
function mapChannel(channel: string | null | undefined): MessageChannel {
  return (MESSAGE_CHANNELS as readonly string[]).includes(channel ?? "")
    ? (channel as MessageChannel)
    : "WHATSAPP";
}

export async function POST(request: Request) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    // Hastanın gerçek konuşmasına yanıt gönderir / kayıt ekler: yalnızca hastayla yazışabilen roller (ADR-0019).
    requireRole(actor, ESCALATION_ROLES);
    const { leadId, message, conversationId } = await body(request, ChatSchema);

    const lead = await prisma.lead.findFirst({
      where: { id: leadId, workspaceId: actor.workspaceId },
      select: { id: true, channel: true },
    });
    if (!lead) throw new HttpError(404, "Lead bulunamadı; silinmiş olabilir. Lead'ler sayfasından yeniden açın.");

    let conversation = conversationId
      ? await prisma.conversation.findFirst({
          where: { id: conversationId, leadId, workspaceId: actor.workspaceId },
          select: { id: true, status: true },
        })
      : await prisma.conversation.findFirst({
          where: { leadId, workspaceId: actor.workspaceId },
          orderBy: { createdAt: "desc" },
          select: { id: true, status: true },
        });
    if (conversationId && !conversation) throw new HttpError(404, "Konuşma bulunamadı; silinmiş olabilir. Lead'ler sayfasından yeniden açın.");
    if (conversation && conversation.status !== "ACTIVE")
      throw new HttpError(409, "Bu konuşmada asistan durduruldu; koordinatör devralmalı.");
    if (!conversation) {
      if (!message) throw new HttpError(409, "Yanıtlanacak gelen mesaj yok. Hastadan yeni mesaj geldiğinde tekrar deneyin.");
      conversation = await prisma.conversation.create({
        data: {
          leadId,
          workspaceId: actor.workspaceId,
          channel: mapChannel(lead.channel),
          initiatedBy: "bot",
        },
        select: { id: true, status: true },
      });
    }

    const result = await respondToInbound(conversation.id, {
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      ...(message ? { simulatedInbound: { text: message, recordedBy: actor.userId } } : {}),
    });
    return {
      conversationId: result.conversationId,
      messages: message ? [message, result.reply] : [result.reply],
      escalated: result.escalated,
      reason: result.reason,
      delivered: result.delivered,
      messageId: result.messageId,
    };
  });
}

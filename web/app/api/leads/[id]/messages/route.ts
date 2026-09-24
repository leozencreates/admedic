import { prisma } from "@admedic/database";
import { requireActor, requireRole, CARE_ROLES } from "../../../../_lib/auth";
import { body, respond, sameOrigin, HttpError } from "../../../../_lib/http";
import { z } from "zod";
import { decrypt } from "../../../../_lib/encrypt";
import {
  sendWhatsAppMessage,
  WINDOW_MS,
} from "../../../../_lib/whatsapp";
import type { MessageDirection, MessageChannel } from "@admedic/database";
export const maxDuration = 15;
const SendMessageSchema = z.object({
  content: z.string().trim().min(1).max(4000),
  direction: z.enum(["OUTGOING"]).optional().default("OUTGOING"),
  channel: z
    .enum(["WHATSAPP", "INSTAGRAM", "MESSENGER", "SMS"])
    .optional()
    .default("WHATSAPP"),
  templateName: z.string().optional(),
  templateParams: z.record(z.string()).optional(),
}).strict();

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return respond(async () => {
    const actor = await requireActor();
    const { id } = await params;
    const conversation = await prisma.conversation.findFirst({
      where: { id, lead: { workspaceId: actor.workspaceId } },
      include: { messages: { orderBy: { createdAt: "asc" }, take: 100 } },
    });
    if (!conversation) throw new HttpError(404, "Konuşma bulunamadı.");
    return {
      conversation: {
        id: conversation.id,
        status: conversation.status,
        messages: conversation.messages,
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
    const { id } = await params;
    const input = await body(request, SendMessageSchema);
    const conversation = await prisma.conversation.findFirst({
      where: { id, lead: { workspaceId: actor.workspaceId } },
      include: { lead: true },
    });
    if (!conversation) throw new HttpError(404, "Konuşma bulunamadı.");
    if (conversation.status === "CLOSED")
      throw new HttpError(409, "Kapalı konuşmaya mesaj gönderilemez.");
    if (conversation.status === "ESCALATED") {
      requireRole(actor, ["OWNER", "ADMIN"]);
    } else {
      requireRole(actor, CARE_ROLES);
    }

    const channel = (input.channel ?? "WHATSAPP") as MessageChannel;
    const isTemplate =
      input.templateName !== undefined && input.templateName !== "";

    if (channel === "WHATSAPP" && !isTemplate) {
      const lastInbound = await prisma.message.findFirst({
        where: { conversationId: conversation.id, direction: "INCOMING" },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      });
      const withinWindow =
        lastInbound &&
        Date.now() - lastInbound.createdAt.getTime() <= WINDOW_MS;
      if (!withinWindow)
        throw new HttpError(
          400,
          "24 saatlik mesajlaşma penceresi dışındasınız; serbest metin gönderilemez. Şablon mesajı (templateName) kullanın.",
        );
    }

    let phone: string | null = null;
    if (conversation.lead.phone) {
      try {
        phone = decrypt(conversation.lead.phone);
      } catch {
        phone = null;
      }
    }

    const result =
      channel === "WHATSAPP"
        ? await sendWhatsAppMessage(
            { phone, language: conversation.lead.language },
            input.content,
            input.templateName ?? null,
            input.templateParams ?? {},
          )
        : { id: null, error: null };
    if (result.error) throw new HttpError(400, result.error);

    const message = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        direction: (input.direction ?? "OUTGOING") as MessageDirection,
        channel,
        content: input.content,
        sender: actor.userId,
        metadata: {
          whatsappTemplate: input.templateName ?? null,
          whatsappTemplateParams: input.templateParams ?? {},
          whatsappResult: {
            id: result.id ?? null,
            error: result.error ?? null,
          },
        },
      },
    });
    if (!conversation.firstResponseAt) {
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { firstResponseAt: new Date() },
      });
    }
    await prisma.auditLog.create({
      data: {
        orgId: actor.orgId,
        workspaceId: actor.workspaceId,
        userId: actor.userId,
        action: "MESSAGE_SENT",
        entityType: "CONVERSATION",
        entityId: conversation.id,
        after: {
          channel,
          template: input.templateName ?? null,
          messageId: message.id,
        },
      },
    });
    return {
      message: {
        id: message.id,
        content: message.content,
        direction: message.direction,
        channel: message.channel,
        sender: message.sender,
        createdAt: message.createdAt,
      },
    };
  });
}
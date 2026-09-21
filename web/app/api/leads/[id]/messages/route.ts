import { prisma } from "@admedic/database";
import { requireActor, requireRole, EDIT_ROLES } from "../../../../_lib/auth";
import { body, respond, sameOrigin, HttpError } from "../../../../_lib/http";
import { z } from "zod";
import type { MessageDirection, MessageChannel } from "@admedic/database";
export const maxDuration = 15;
const SendMessageSchema = z.object({
  content: z.string().trim().min(1).max(4000),
  direction: z.enum(["OUTGOING"]).optional().default("OUTGOING"),
  channel: z.enum(["WHATSAPP", "INSTAGRAM", "MESSENGER", "SMS"]).optional().default("WHATSAPP"),
}).strict();
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    const actor = await requireActor();
    const { id } = await params;
    const conversation = await prisma.conversation.findFirst({
      where: { id, lead: { workspaceId: actor.workspaceId } },
      include: { messages: { orderBy: { createdAt: "asc" }, take: 100 } },
    });
    if (!conversation) throw new HttpError(404, "Konuşma bulunamadı.");
    return { conversation: { id: conversation.id, status: conversation.status, messages: conversation.messages } };
  });
}
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, EDIT_ROLES);
    const { id } = await params;
    const input = await body(request, SendMessageSchema);
    const conversation = await prisma.conversation.findFirst({
      where: { id, lead: { workspaceId: actor.workspaceId } },
    });
    if (!conversation) throw new HttpError(404, "Konuşma bulunamadı.");
    if (conversation.status !== "ACTIVE") throw new HttpError(409, "Bu konuşma durduruldu veya eskalasyon altındadır.");
    const message = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        direction: (input.direction ?? "OUTGOING") as MessageDirection,
        channel: (input.channel ?? "WHATSAPP") as MessageChannel,
        content: input.content,
        sender: actor.userId,
        metadata: {},
      },
    });
    if (input.channel === "WHATSAPP") {
      const whatsappMessage = await sendWhatsAppMessage(conversation.leadId, input.content, actor);
      if (whatsappMessage) {
        await prisma.message.create({
          data: {
            conversationId: conversation.id,
            direction: "OUTGOING",
            channel: "WHATSAPP",
            content: whatsappMessage.id ? `[WhatsApp gönderildi: ${whatsappMessage.id}]` : whatsappMessage.error ?? "Gönderilemedi",
            sender: "bot",
            metadata: { whatsappMessageId: whatsappMessage.id ?? null, error: whatsappMessage.error ?? null },
          },
        });
      }
    }
    return { message: { id: message.id, content: message.content, direction: message.direction, channel: message.channel, sender: message.sender, createdAt: message.createdAt } };
  });
}
interface WhatsAppResponse { id?: string; error?: string | null }
async function sendWhatsAppMessage(leadId: string, text: string, actor: { orgId: string; workspaceId: string }): Promise<WhatsAppResponse> {
  const phone = process.env.WHATSAPP_PHONE_NUMBER;
  const token = process.env.WHATSAPP_TOKEN;
  const url = process.env.WHATSAPP_API_URL;
  if (!phone || !token || !url) return { error: "WhatsApp yapılandırılmadı." };
  try {
    const response = await fetch(`${url}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to: phone, type: "text", text: { body: text } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return { error: `WhatsApp API hatası: ${response.status}` };
    const data = await response.json();
    return { id: data.messages?.[0]?.id ?? null };
  } catch {
    return { error: "WhatsApp gönderilemedi." };
  }
}

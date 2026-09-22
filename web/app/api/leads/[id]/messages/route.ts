import { prisma } from "@admedic/database";
import { requireActor, requireRole, EDIT_ROLES } from "../../../../_lib/auth";
import { body, respond, sameOrigin, HttpError } from "../../../../_lib/http";
import { z } from "zod";
import type { MessageDirection, MessageChannel } from "@admedic/database";
export const maxDuration = 15;
const TEMPLATE_PATTERN = /^[A-Z0-9_]{1,32}$/;
const SendMessageSchema = z.object({
  content: z.string().trim().min(1).max(4000),
  direction: z.enum(["OUTGOING"]).optional().default("OUTGOING"),
  channel: z.enum(["WHATSAPP", "INSTAGRAM", "MESSENGER", "SMS"]).optional().default("WHATSAPP"),
  templateName: z.string().optional(),
  templateParams: z.record(z.string()).optional(),
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
      include: { lead: true },
    });
    if (!conversation) throw new HttpError(404, "Konuşma bulunamadı.");
    if (conversation.status === "ESCALATED") throw new HttpError(409, "Bu konuşma koordinatöre devredildi.");
    if (input.channel === "WHATSAPP") {
      const whatsappResult = await sendWhatsAppMessage(conversation.lead, { content: input.content, templateName: input.templateName, templateParams: input.templateParams, channel: "WHATSAPP" }, actor);
      if (whatsappResult.error) throw new HttpError(400, whatsappResult.error);
    }
    const message = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        direction: (input.direction ?? "OUTGOING") as MessageDirection,
        channel: (input.channel ?? "WHATSAPP") as MessageChannel,
        content: input.content,
        sender: actor.userId,
        metadata: {
          whatsappTemplate: input.templateName ?? null,
          whatsappTemplateParams: input.templateParams ?? {},
          whatsappResult: {
            id: null,
            error: null,
          },
        },
      },
    });
    if (input.channel === "WHATSAPP") {
      const whatsappResult = await sendWhatsAppMessage(conversation.lead, { content: input.content, templateName: input.templateName, templateParams: input.templateParams, channel: "WHATSAPP" }, actor);
      await prisma.message.update({
        where: { id: message.id },
        data: { metadata: { whatsappTemplate: input.templateName ?? null, whatsappTemplateParams: input.templateParams ?? {}, whatsappResult: { id: whatsappResult.id ?? null, error: whatsappResult.error ?? null } } },
      });
    }
    return { message: { id: message.id, content: message.content, direction: message.direction, channel: message.channel, sender: message.sender, createdAt: message.createdAt } };
  });
}
interface WhatsAppResponse { id?: string; error?: string | null }
async function sendWhatsAppMessage(lead: { language: string; phone: string | null }, input: { content: string; templateName?: string; templateParams?: Record<string, string>; channel: string }, actor: { orgId: string; workspaceId: string }): Promise<WhatsAppResponse> {
  const phone = lead.phone;
  const token = process.env.WHATSAPP_TOKEN;
  const url = process.env.WHATSAPP_API_URL;
  const templateName = input.templateName;
  const templateParams = input.templateParams ?? {};
  if (!phone) return { error: "Lead telefon numarası yok." };
  if (!token || !url) return { id: "mock_" + Date.now(), error: null };
  if (templateName && !TEMPLATE_PATTERN.test(templateName)) return { error: "Geçersiz WhatsApp şablonu adı." };
  const body = templateName
    ? { messaging_product: "whatsapp", to: phone, type: "template", template: { name: templateName, language: { code: lead.language.toLowerCase() }, components: [{ type: "body", parameters: Object.values(templateParams).map((v) => ({ text: v })) }] } }
    : { messaging_product: "whatsapp", to: phone, type: "text", text: { body: input.content } };
  try {
    const response = await fetch(`${url}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return { error: `WhatsApp API hatası: ${response.status}` };
    const data = await response.json();
    return { id: data.messages?.[0]?.id ?? null };
  } catch {
    return { error: "WhatsApp gönderilemedi." };
  }
}

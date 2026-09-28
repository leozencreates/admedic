import { prisma } from "@admedic/database";
import { requireActor, requireRole, CARE_ROLES, ESCALATION_ROLES } from "../../../_lib/auth";
import { body, respond, sameOrigin, HttpError } from "../../../_lib/http";
import { logAudit } from "../../../_lib/audit";
import { memberDisplayNames } from "../../../_lib/conversation-claim";
import { lastRealInboundAt, replyWindow } from "../../../_lib/messaging-window";
import { z } from "zod";
export const maxDuration = 30;

const MessageChannelEnum = z.enum(["WHATSAPP", "INSTAGRAM", "MESSENGER", "SMS"]);

const CreateConversationSchema = z.object({
  channel: MessageChannelEnum,
  /** Eski istemciler için kabul edilir ama yok sayılır: başlatan her zaman oturumdaki kullanıcıdır (denetim izi). */
  initiatedBy: z.string().nullable().optional(),
}).strict();

/**
 * Lead'in konuşmaları (`id` = lead kimliği), en yenisi önce; her konuşmada son 50 mesaj (yeniden eskiye).
 * Devir durumu için `escalatedToName` (devralan ekip üyesinin görünen adı) ve `escalatedToIsMe` döner:
 * ESCALATED + `escalatedTo` boş = asistan devretti, henüz kimse devralmadı.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    const actor = await requireActor();
    // Mesaj içeriği hastanın kişisel (çoğu zaman sağlık) verisidir: yalnızca bakım rolleri okur (ADR-0019).
    requireRole(actor, CARE_ROLES);
    const { id } = await params;
    const lead = await prisma.lead.findFirst({
      where: { id, workspaceId: actor.workspaceId },
    });
    if (!lead) throw new HttpError(404, "Lead bulunamadı; silinmiş olabilir. Lead'ler sayfasından yeniden açın.");
    const conversations = await prisma.conversation.findMany({
      where: { leadId: id },
      include: {
        // Aynı milisaniyedeki kayıtlar (ör. devralma notu + ilk yanıt) oluşturulma sırasıyla kalsın.
        messages: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 50 },
      },
      orderBy: { createdAt: "desc" },
    });
    const [names, inbound] = await Promise.all([
      memberDisplayNames(actor.orgId, conversations.map((c) => c.escalatedTo)),
      Promise.all(conversations.map((c) => (c.status === "CLOSED" ? null : lastRealInboundAt(c.id)))),
    ]);
    const now = new Date();
    return {
      /** Bu kullanıcı hastaya yazabilir / konuşmayı devralabilir mi (ESCALATION_ROLES; sunucu her istekte yeniden denetler). */
      canReply: ESCALATION_ROLES.includes(actor.role),
      conversations: conversations.map((c, i) => ({
        ...c,
        escalatedToName: c.escalatedTo ? (names.get(c.escalatedTo) ?? null) : null,
        escalatedToIsMe: c.escalatedTo !== null && c.escalatedTo === actor.userId,
        // 24 saatlik mesajlaşma penceresi: son gerçek hasta mesajı ve kapanış anı.
        replyWindow: replyWindow(inbound[i], now),
      })),
    };
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, ESCALATION_ROLES);
    const { id } = await params;
    const input = await body(request, CreateConversationSchema);
    const lead = await prisma.lead.findFirst({
      where: { id, workspaceId: actor.workspaceId },
    });
    if (!lead) throw new HttpError(404, "Lead bulunamadı; silinmiş olabilir. Lead'ler sayfasından yeniden açın.");
    const conversation = await prisma.$transaction(async (tx) => {
      const created = await tx.conversation.create({
        data: {
          leadId: id,
          workspaceId: actor.workspaceId,
          channel: input.channel,
          initiatedBy: actor.userId,
        },
      });
      await logAudit({
        actor,
        action: "CONVERSATION_CREATED",
        entityType: "CONVERSATION",
        entityId: created.id,
        after: { leadId: id, channel: input.channel },
      }, tx);
      return created;
    });
    return { conversation };
  });
}

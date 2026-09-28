import { prisma } from "@admedic/database";
import { requireActor, requireRole, ESCALATION_ROLES, type Actor } from "../../../../_lib/auth";
import { body, respond, sameOrigin, HttpError } from "../../../../_lib/http";
import { logAudit } from "../../../../_lib/audit";
import {
  claimHandoff,
  memberDisplayNames,
  resolveHandoffAlerts,
  userDisplayName,
} from "../../../../_lib/conversation-claim";
import { z } from "zod";
export const maxDuration = 10;
const EscalateSchema = z.object({ note: z.string().max(1000).optional() }).strict();

/** Devralınamayan konuşma için 409: kapalı ya da zaten bir ekip üyesinde. */
async function conflict(
  actor: Actor,
  conversation: { status: string; escalatedTo: string | null } | null,
): Promise<HttpError> {
  if (!conversation) return new HttpError(404, "Konuşma bulunamadı.");
  if (conversation.status === "CLOSED") return new HttpError(409, "Kapalı konuşma devralınamaz.");
  if (conversation.status === "ESCALATED" && conversation.escalatedTo) {
    if (conversation.escalatedTo === actor.userId) return new HttpError(409, "Konuşmayı zaten siz devraldınız.");
    const names = await memberDisplayNames(actor.orgId, [conversation.escalatedTo]);
    const name = names.get(conversation.escalatedTo) ?? "bir ekip üyesi";
    return new HttpError(409, `Konuşma zaten ${name} tarafından devralındı.`);
  }
  return new HttpError(409, "Konuşma bu sırada değişti; sayfayı yenileyip tekrar deneyin.");
}

/**
 * Konuşmayı devral (spec 3.8):
 * - ACTIVE → ESCALATED: asistan yanıtlarken ekip konuşmayı üstlenir (ESCALATION_ROLES; ADR-0019).
 * - ESCALATED ve sahipsiz (asistan devretti): konuşma devralan kişiye yazılır, sistem notu ve denetim
 *   kaydı eklenir, açık devir uyarıları çözülür.
 * Devralma her durumda yalnızca ESCALATION_ROLES'a (Hesap sahibi, Yönetici, Hasta koordinatörü) açıktır;
 * reklam uzmanı devralamaz.
 * - Zaten devralınmış ya da kapalı konuşma: 409.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, ESCALATION_ROLES);
    const { id } = await params;
    const input = await body(request, EscalateSchema);
    const conversation = await prisma.conversation.findFirst({
      where: { id, lead: { workspaceId: actor.workspaceId } },
    });
    if (!conversation) throw new HttpError(404, "Konuşma bulunamadı.");
    const claim = conversation.status === "ESCALATED";
    if (conversation.status === "CLOSED" || (claim && conversation.escalatedTo)) throw await conflict(actor, conversation);
    const displayName = await userDisplayName(actor.userId);
    const note = input.note?.trim() || undefined;
    const done = await prisma.$transaction(async (tx) => {
      if (claim) {
        return claimHandoff(tx, {
          actor,
          conversation: { id: conversation.id, workspaceId: conversation.workspaceId, channel: conversation.channel },
          displayName,
          via: "button",
          note,
        });
      }
      const now = new Date();
      // Koşullu geçiş: asistan bu arada devrettiyse ya da başka biri devraldıysa yazılmaz (409).
      const updated = await tx.conversation.updateMany({
        where: { id, status: "ACTIVE" },
        data: { status: "ESCALATED", escalatedTo: actor.userId, escalatedAt: now },
      });
      if (updated.count === 0) return false;
      // Sistem notu: dış kanala gönderilmez, yalnızca panelde görünür.
      await tx.message.create({
        data: {
          conversationId: conversation.id,
          direction: "OUTGOING",
          channel: conversation.channel,
          content: `Konuşma ${displayName} tarafından devralındı; asistan susturuldu.${note ? ` Not: ${note}` : ""}`,
          sender: "system",
          metadata: { type: "ESCALATION" },
        },
      });
      // Asistanın açtığı "yanıt üretemedi" gibi devir uyarıları artık bir sahibi olduğu için çözülür.
      const resolvedAlertIds = await resolveHandoffAlerts(tx, conversation.workspaceId, conversation.id, now);
      await logAudit({
        actor,
        action: "CONVERSATION_ESCALATED",
        entityType: "CONVERSATION",
        entityId: conversation.id,
        before: { status: conversation.status },
        after: { status: "ESCALATED", hasNote: Boolean(note), resolvedAlertIds },
      }, tx);
      return true;
    });
    if (!done) {
      const current = await prisma.conversation.findUnique({
        where: { id },
        select: { status: true, escalatedTo: true },
      });
      throw await conflict(actor, current);
    }
    return {
      conversation: { id, status: "ESCALATED", escalatedTo: actor.userId, claimed: claim },
    };
  });
}

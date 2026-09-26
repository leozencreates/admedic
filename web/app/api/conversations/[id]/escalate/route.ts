import { prisma } from "@admedic/database";
import { requireActor, requireRole, CARE_ROLES } from "../../../../_lib/auth";
import { body, respond, sameOrigin, HttpError } from "../../../../_lib/http";
import { logAudit } from "../../../../_lib/audit";
import { z } from "zod";
export const maxDuration = 10;
const EscalateSchema = z.object({ note: z.string().max(1000).optional() }).strict();

/** Sistem notunda kullanıcı kimliği yerine görünen ad (yoksa e-postanın yerel kısmı) yazılır. */
async function actorDisplayName(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { name: true, email: true },
  });
  const name = user?.name?.trim();
  if (name) return name;
  const local = user?.email?.split("@")[0]?.trim();
  return local || "ekip üyesi";
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, CARE_ROLES);
    const { id } = await params;
    const input = await body(request, EscalateSchema);
    const conversation = await prisma.conversation.findFirst({
      where: { id, lead: { workspaceId: actor.workspaceId } },
    });
    if (!conversation) throw new HttpError(404, "Konuşma bulunamadı.");
    if (conversation.status === "ESCALATED") throw new HttpError(409, "Zaten eskalasyon altındadır.");
    if (conversation.status === "CLOSED") throw new HttpError(409, "Kapalı konuşma devralınamaz.");
    const displayName = await actorDisplayName(actor.userId);
    const note = input.note?.trim();
    await prisma.$transaction(async (tx) => {
      await tx.conversation.update({
        where: { id },
        data: { status: "ESCALATED", escalatedTo: actor.userId, escalatedAt: new Date() },
      });
      // Sistem notu: dış kanala gönderilmez, yalnızca panelde görünür.
      await tx.message.create({
        data: {
          conversationId: conversation.id,
          direction: "OUTGOING",
          channel: conversation.channel,
          content: `⚠ Konuşma ${displayName} tarafından devralındı; asistan susturuldu.${note ? ` Not: ${note}` : ""}`,
          sender: "system",
          metadata: { type: "ESCALATION" },
        },
      });
      await logAudit({
        actor,
        action: "CONVERSATION_ESCALATED",
        entityType: "CONVERSATION",
        entityId: conversation.id,
        before: { status: conversation.status },
        after: { status: "ESCALATED", hasNote: Boolean(note) },
      }, tx);
    });
    return { conversation: { id, status: "ESCALATED" } };
  });
}

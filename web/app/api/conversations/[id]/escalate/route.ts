import { prisma } from "@admedic/database";
import { requireActor, requireRole, EDIT_ROLES } from "../../../../_lib/auth";
import { body, respond, sameOrigin } from "../../../../_lib/http";
import { z } from "zod";
export const maxDuration = 10;
const EscalateSchema = z.object({ note: z.string().max(1000).optional() }).strict();
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, EDIT_ROLES);
    const { id } = await params;
    const input = await body(request, EscalateSchema);
    const conversation = await prisma.conversation.findFirst({
      where: { id, lead: { workspaceId: actor.workspaceId } },
    });
    if (!conversation) throw new HttpError(404, "Konuşma bulunamadı.");
    if (conversation.status === "ESCALATED") throw new HttpError(409, "Zaten eskalasyon altındadır.");
    await prisma.conversation.update({
      where: { id },
      data: { status: "ESCALATED", escalatedTo: actor.userId, escalatedAt: new Date() },
    });
    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        direction: "OUTGOING" as const, channel: "WHATSAPP" as any,
        content: `⚠ Konuşma koordinatör ${actor.userId} tarafından devredildi. ${input.note ?? ""}`,
        sender: "system" as const, metadata: { type: "ESCALATION" },
      },
    });
    return { conversation: { id, status: "ESCALATED" } };
  });
}
import { HttpError } from "../../../../_lib/http";

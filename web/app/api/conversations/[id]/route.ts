import { prisma } from "@admedic/database";
import { requireActor, requireRole, CARE_ROLES } from "../../../_lib/auth";
import { body, respond, sameOrigin, HttpError } from "../../../_lib/http";
import { logAudit } from "../../../_lib/audit";
import { z } from "zod";
export const maxDuration = 30;

const MessageChannelEnum = z.enum(["WHATSAPP", "INSTAGRAM", "MESSENGER", "SMS"]);

const CreateConversationSchema = z.object({
  channel: MessageChannelEnum,
  initiatedBy: z.string().nullable().optional(),
}).strict();

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    const actor = await requireActor();
    const { id } = await params;
    const lead = await prisma.lead.findFirst({
      where: { id, workspaceId: actor.workspaceId },
    });
    if (!lead) throw new HttpError(404, "Lead bulunamadı.");
    const conversations = await prisma.conversation.findMany({
      where: { leadId: id },
      include: {
        messages: { orderBy: { createdAt: "desc" }, take: 50 },
      },
      orderBy: { createdAt: "desc" },
    });
    return { conversations };
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, CARE_ROLES);
    const { id } = await params;
    const input = await body(request, CreateConversationSchema);
    const lead = await prisma.lead.findFirst({
      where: { id, workspaceId: actor.workspaceId },
    });
    if (!lead) throw new HttpError(404, "Lead bulunamadı.");
    const conversation = await prisma.$transaction(async (tx) => {
      const created = await tx.conversation.create({
        data: {
          leadId: id,
          workspaceId: actor.workspaceId,
          channel: input.channel,
          initiatedBy: input.initiatedBy ?? actor.userId,
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

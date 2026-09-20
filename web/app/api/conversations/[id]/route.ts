import { prisma } from "@admedic/database";
import { requireActor } from "../../../_lib/auth";
import { body, respond, sameOrigin, HttpError } from "../../../_lib/http";
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
    const { id } = await params;
    const input = await body(request, CreateConversationSchema);
    const lead = await prisma.lead.findFirst({
      where: { id, workspaceId: actor.workspaceId },
    });
    if (!lead) throw new HttpError(404, "Lead bulunamadı.");
    const conversation = await prisma.conversation.create({
      data: {
        leadId: id,
        workspaceId: actor.workspaceId,
        channel: input.channel,
        initiatedBy: input.initiatedBy ?? undefined,
      },
    });
    return { conversation };
  });
}

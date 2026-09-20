import { prisma } from "@admedic/database";
import { requireActor } from "../../../../_lib/auth";
import { body, respond, sameOrigin, HttpError } from "../../../../_lib/http";
import { z } from "zod";
export const maxDuration = 30;

const MessageDirectionEnum = z.enum(["INCOMING", "OUTGOING"]);
const MessageChannelEnum = z.enum(["WHATSAPP", "INSTAGRAM", "MESSENGER", "SMS"]);

const SendMessageSchema = z.object({
  content: z.string().min(1).max(10000),
  direction: MessageDirectionEnum,
  channel: MessageChannelEnum,
  sender: z.string().nullable().optional(),
}).strict();

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    const { id } = await params;
    const input = await body(request, SendMessageSchema);
    const conversation = await prisma.conversation.findFirst({
      where: { id, workspaceId: actor.workspaceId },
      include: { lead: true },
    });
    if (!conversation) throw new HttpError(404, "Konuşma bulunamadı.");
    const message = await prisma.message.create({
      data: {
        conversationId: id,
        direction: input.direction,
        channel: input.channel,
        content: input.content,
        sender: input.sender ?? undefined,
      },
    });
    if (input.direction === "OUTGOING" && input.channel === "WHATSAPP") {
      await prisma.conversation.update({
        where: { id },
        data: { status: "ACTIVE" },
      });
    }
    return { message };
  });
}

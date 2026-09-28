import { prisma } from "@admedic/database";
import { requireActor } from "../../../../_lib/auth";
import { respond, HttpError } from "../../../../_lib/http";
export const maxDuration = 30;

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    const actor = await requireActor();
    const { id } = await params;
    const conversation = await prisma.conversation.findFirst({
      where: { id, workspaceId: actor.workspaceId },
      include: { messages: { orderBy: { createdAt: "asc" }, take: 100 } },
    });
    if (!conversation) throw new HttpError(404, "Konuşma bulunamadı; silinmiş olabilir. Lead'ler sayfasından yeniden açın.");
    return { conversation: { id: conversation.id, status: conversation.status, messages: conversation.messages } };
  });
}

export async function POST() {
  return respond(async () => {
    throw new HttpError(
      410,
      "Panel mesaj gönderimi artık bu uçtan yapılmaz; WHATSAPP iletimi için POST /api/leads/:id/messages kullanın.",
    );
  });
}

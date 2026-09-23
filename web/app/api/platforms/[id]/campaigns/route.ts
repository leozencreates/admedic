import { prisma } from "@admedic/database";
import { requireActor } from "../../../../_lib/auth";
import { respond, sameOrigin } from "../../../../_lib/http";
export const maxDuration = 15;
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    const { id } = await params;
    const account = await prisma.adAccount.findFirst({
      where: { id, workspaceId: actor.workspaceId },
      include: { campaigns: { select: { id: true, name: true, status: true } } },
    });
    if (!account) throw new HttpError(404, "Reklam hesabı bulunamadı.");
    return { campaigns: account.campaigns };
  });
}
import { HttpError } from "../../../../_lib/http";

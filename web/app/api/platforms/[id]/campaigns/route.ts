import { prisma } from "@admedic/database";
import { requireActor } from "../../../../_lib/auth";
import { respond, HttpError } from "../../../../_lib/http";
export const maxDuration = 15;
/** Salt okunur GET: tarayıcı aynı kaynaklı GET'te Origin göndermez → sameOrigin kullanılmaz. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    const actor = await requireActor();
    const { id } = await params;
    const account = await prisma.adAccount.findFirst({
      where: { id, workspaceId: actor.workspaceId },
      include: { campaigns: { select: { id: true, name: true, status: true } } },
    });
    if (!account) throw new HttpError(404, "Reklam hesabı bulunamadı. Platformlar sayfasından hesabı kontrol edin ya da Meta ile yeniden bağlanın.");
    return { campaigns: account.campaigns };
  });
}

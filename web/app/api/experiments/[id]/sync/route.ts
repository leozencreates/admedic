import { prisma } from "@admedic/database";
import { requireActor, requireRole, EDIT_ROLES } from "../../../../_lib/auth";
import { respond, sameOrigin, HttpError } from "../../../../_lib/http";

/**
 * Studio deneyleri manuel ölçümle çalışır: varyantların Meta reklam seti/reklam eşleştirmesi
 * olmadığı için Meta Insights'tan otomatik metrik çekilemez (tüm hesabı her varyanta yazmak
 * yanlış olurdu). Deney tenant içinde bulunur (404), ardından her zaman 409 döner.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, EDIT_ROLES);
    const { id } = await params;
    const experiment = await prisma.studioExperiment.findFirst({
      where: { id, draft: { workspaceId: actor.workspaceId } }, select: { id: true, status: true },
    });
    if (!experiment) throw new HttpError(404, "A/B testi bulunamadı; silinmiş olabilir. A/B testleri sayfasından yeniden açın.");
    throw new HttpError(
      409,
      "Bu deney manuel ölçüm kullanıyor: otomatik Meta senkronizasyonu yok. Varyantların harcama/tıklama/lead değerlerini deney sayfasından girin; " +
        "varyant–reklam seti eşleştirmesi eklendiğinde otomatik ölçüm açılacaktır.",
    );
  });
}

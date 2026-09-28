import { prisma } from "@admedic/database";
import { requireActor, requireRole } from "../../../../_lib/auth";
import { HttpError, respond, sameOrigin } from "../../../../_lib/http";
import { logAudit } from "../../../../_lib/audit";
export const maxDuration = 15;

/** Öneri onayı: PENDING → APPROVED (yalnızca OWNER/ADMIN; spec 3.6). Uygulama ayrı adımdır. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, ["OWNER", "ADMIN"]);
    const { id } = await params;
    const rec = await prisma.recommendation.findFirst({ where: { id, workspaceId: actor.workspaceId } });
    if (!rec) throw new HttpError(404, "Öneri bulunamadı; silinmiş olabilir. Öneriler sayfasını yenileyin.");
    if (rec.status === "APPROVED") throw new HttpError(409, "Bu öneri zaten onaylanmış.");
    if (rec.status !== "PENDING") throw new HttpError(409, "Yalnızca onay bekleyen öneri onaylanabilir. Önerinin durumu değişmiş olabilir; sayfayı yenileyin.");
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      const result = await tx.recommendation.updateMany({
        where: { id, workspaceId: actor.workspaceId, status: "PENDING" },
        data: { status: "APPROVED", approvedBy: actor.userId, approvedAt: now },
      });
      if (!result.count) throw new HttpError(409, "Öneri bu sırada değişti; sayfayı yenileyin.");
      await logAudit(
        {
          actor,
          action: "RECOMMENDATION_APPROVED",
          entityType: "RECOMMENDATION",
          entityId: id,
          before: { status: rec.status },
          after: { status: "APPROVED", approvedAt: now.toISOString() },
        },
        tx,
      );
    });
    return { ok: true, status: "APPROVED" };
  });
}

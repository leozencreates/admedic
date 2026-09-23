import { prisma } from "@admedic/database";
import { requireActor } from "@/app/_lib/auth";
import { respond, sameOrigin } from "@/app/_lib/http";
export const maxDuration = 15;
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, ["OWNER", "ADMIN"]);
    const { id } = await params;
    const rec = await prisma.recommendation.findFirst({ where: { id, workspaceId: actor.workspaceId } });
    if (!rec) throw new HttpError(404, "Öneri bulunamadı.");
    if (rec.status !== "PENDING") throw new HttpError(409, "Bu öneri zaten onaylanmış.");
    await prisma.recommendation.update({ where: { id }, data: { status: "APPROVED", approvedBy: actor.userId, approvedAt: new Date() } });
    await prisma.auditLog.create({ data: { orgId: actor.orgId, workspaceId: actor.workspaceId, userId: actor.userId, action: "RECOMMENDATION_APPROVED", entityType: "RECOMMENDATION", entityId: id, after: { status: "APPROVED" } } });
    return { ok: true, status: "APPROVED" };
  });
}
import { HttpError } from "@/app/_lib/http";
import { requireRole } from "@/app/_lib/auth";

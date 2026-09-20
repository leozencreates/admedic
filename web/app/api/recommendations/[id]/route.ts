import { prisma } from "@admedic/database";
import { requireActor, requireRole } from "../../../_lib/auth";
import { body, respond, sameOrigin } from "../../../_lib/http";
import { z } from "zod";
export const maxDuration = 60;

const ActionSchema = z.object({ action: z.enum(["approve", "reject", "apply"]), version: z.number().int().positive() }).strict();

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    const { id } = await params;
    const input = await body(request, ActionSchema);
    const rec = await prisma.recommendation.findFirst({
      where: { id, workspaceId: actor.workspaceId },
    });
    if (!rec) throw new Error("Öneri bulunamadı.");
    if (input.version !== rec.version) throw new Error("Öneri değişmiş. Sayfayı yenileyin.");
    if (input.action === "approve") {
      requireRole(actor, ["OWNER", "ADMIN"]);
      await prisma.recommendation.update({ where: { id }, data: { status: "APPROVED", approvedBy: actor.userId, approvedAt: new Date() } });
    } else if (input.action === "reject") {
      requireRole(actor, ["OWNER", "ADMIN"]);
      await prisma.recommendation.update({ where: { id }, data: { status: "REJECTED" } });
    } else if (input.action === "apply") {
      if (rec.status !== "APPROVED") throw new Error("Önce onayla.");
      await prisma.recommendation.update({ where: { id }, data: { status: "APPLIED", appliedAt: new Date() } });
    }
    return { ok: true };
  });
}

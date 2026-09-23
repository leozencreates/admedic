import { prisma } from "@admedic/database";
import { requireActor, requireRole } from "@/app/_lib/auth";
import { body, respond, sameOrigin } from "@/app/_lib/http";
import { z } from "zod";
export const maxDuration = 60;
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    const actor = await requireActor();
    const { id } = await params;
    const rec = await prisma.recommendation.findFirst({ where: { id, workspaceId: actor.workspaceId } });
    if (!rec) throw new HttpError(404, "Öneri bulunamadı.");
    return { recommendation: rec };
  });
}
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, ["OWNER", "ADMIN"]);
    const { id } = await params;
    const input = await body(request, z.object({ status: z.enum(["DRAFT", "PENDING", "APPROVED", "APPLIED", "REJECTED"]).optional() }).strict());
    const rec = await prisma.recommendation.findFirst({ where: { id } });
    if (!rec) throw new HttpError(404, "Öneri bulunamadı.");
    await prisma.recommendation.update({ where: { id }, data: { status: input.status } });
    return { ok: true };
  });
}
import { HttpError } from "@/app/_lib/http";

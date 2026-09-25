import { prisma } from "@admedic/database";
import { requireActor, requireRole, EDIT_ROLES } from "../../../../../_lib/auth";
import { body, respond, sameOrigin, HttpError } from "../../../../../_lib/http";
import { logAudit } from "../../../../../_lib/audit";
import { z } from "zod";

export const maxDuration = 15;

const TargetPatchSchema = z
  .object({
    region: z.string().optional(),
    language: z.enum(["TR", "EN", "DE", "RU", "AR", "FR", "NL", "PL"]).optional(),
    currency: z.string().optional(),
    demand: z.number().optional(),
  })
  .strict();

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; country: string }> },
) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, ["OWNER", "ADMIN", ...EDIT_ROLES]);
    const { id, country } = await params;
    const input = await body(request, TargetPatchSchema);
    const target = await prisma.marketTarget.findFirst({
      where: { clinicId: id, country },
      include: { clinic: { select: { workspaceId: true } } },
    });
    if (!target) throw new HttpError(404, "Hedef pazar bulunamadı.");
    const clinic = target.clinic;
    const actorWorkspace = await prisma.workspace.findUnique({
      where: { id: actor.workspaceId },
      select: { id: true },
    });
    if (clinic.workspaceId !== actorWorkspace?.id)
      throw new HttpError(403, "Bu kayda ait değil.");
    const updated = await prisma.marketTarget.update({
      where: { id: target.id },
      data: {
        region: input.region ?? target.region,
        language: input.language ?? target.language,
        currency: input.currency ?? target.currency,
        demand: input.demand ?? target.demand,
      },
    });
    await logAudit({
      actor, action: "MARKET_TARGET_UPDATED", entityType: "MARKET_TARGET",
      entityId: updated.id,
      before: { country: target.country },
      after: { country: updated.country, language: updated.language },
    });
    return { target: updated };
  });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; country: string }> },
) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, ["OWNER", "ADMIN", ...EDIT_ROLES]);
    const { id, country } = await params;
    const target = await prisma.marketTarget.findFirst({
      where: { clinicId: id, country },
      include: { clinic: { select: { workspaceId: true } } },
    });
    if (!target) throw new HttpError(404, "Hedef pazar bulunamadı.");
    if (target.clinic.workspaceId !== actor.workspaceId)
      throw new HttpError(403, "Bu kayda ait değil.");
    await prisma.marketTarget.delete({ where: { id: target.id } });
    await logAudit({ actor, action: "MARKET_TARGET_DELETED", entityType: "MARKET_TARGET", entityId: target.id, before: { country } });
    return { ok: true };
  });
}
import { prisma } from "@admedic/database";
import { requireActor, requireRole, EDIT_ROLES } from "../../../_lib/auth";
import { respond, sameOrigin, HttpError } from "../../../_lib/http";
import { logAudit } from "../../../_lib/audit";

export const maxDuration = 10;

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, EDIT_ROLES);
    const { id } = await params;
    const service = await prisma.service.findFirst({
      where: { id, clinic: { workspaceId: actor.workspaceId } },
    });
    if (!service) throw new HttpError(404, "Hizmet bulunamadı.");
    const updated = await prisma.service.update({
      where: { id },
      data: { status: "ARCHIVED" },
    });
    await logAudit({
      actor,
      action: "SERVICE_ARCHIVED",
      entityType: "SERVICE",
      entityId: id,
      before: { status: service.status },
      after: { status: updated.status },
    });
    return { service: updated };
  });
}
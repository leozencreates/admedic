import { prisma } from "@admedic/database";
import { requireActor, requireRole, EDIT_ROLES } from "../../../../_lib/auth";
import { body, respond, sameOrigin, HttpError } from "../../../../_lib/http";
import { z } from "zod";
import { logAudit } from "../../../../_lib/audit";
export const maxDuration = 15;
const PublishSchema = z.object({
  action: z.enum(["PAUSE", "ACTIVATE", "ARCHIVE"]),
}).strict();
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, EDIT_ROLES);
    const { id } = await params;
    const input = await body(request, PublishSchema);
    const campaign = await prisma.campaign.findFirst({
      where: { id, workspaceId: actor.workspaceId },
      include: { adAccount: { select: { id: true, metaAccountId: true, connectionId: true } } },
    });
    if (!campaign) throw new HttpError(404, "Kampanya bulunamadı.");
    const adAccount = campaign.adAccount;
    if (!adAccount?.connectionId) throw new HttpError(400, "Meta bağlantısı yapılandırılmadı.");
    const conn = await prisma.metaConnection.findUnique({ where: { id: adAccount.connectionId } });
    if (!conn || conn.status !== "CONNECTED") throw new HttpError(400, "Meta bağlantısı aktif değil.");
    const newStatus: Record<string, string> = { PAUSE: "PAUSED", ACTIVATE: "ACTIVE", ARCHIVE: "ARCHIVED" };
    await prisma.campaign.update({ where: { id }, data: { status: newStatus[input.action] as any } });
    await logAudit({
      actor,
      action: "CAMPAIGN_STATUS_CHANGED",
      entityType: "CAMPAIGN",
      entityId: campaign.id,
      before: { status: campaign.status },
      after: { status: newStatus[input.action], action: input.action },
    });
    return { campaign: { id: campaign.id, name: campaign.name, status: newStatus[input.action], action: input.action } };
  });
}

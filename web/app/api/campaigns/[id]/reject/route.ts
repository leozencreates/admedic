import { prisma } from "@admedic/database";
import { requireActor, requireRole } from "../../../../_lib/auth";
import { body, respond, sameOrigin, HttpError } from "../../../../_lib/http";
import { z } from "zod";
import { logAudit } from "../../../../_lib/audit";
import { ownedCampaign } from "../../../../_lib/campaign-workflow";

export const maxDuration = 15;

const RejectSchema = z
  .object({ reason: z.string().trim().min(3).max(500) })
  .strict();

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, ["OWNER", "ADMIN"]);
    const { id } = await params;
    const input = await body(request, RejectSchema);
    const campaign = await ownedCampaign(actor, id);
    if (campaign.workflowStatus !== "IN_REVIEW")
      throw new HttpError(409, "Yalnızca incelemedeki kampanya reddedilebilir.");
    const updated = await prisma.campaign.update({
      where: { id },
      data: {
        workflowStatus: "REJECTED",
        rejectionBy: actor.userId,
        rejectionReason: input.reason,
      },
    });
    await logAudit({
      actor,
      action: "CAMPAIGN_REJECTED",
      entityType: "CAMPAIGN",
      entityId: campaign.id,
      before: { workflowStatus: campaign.workflowStatus },
      after: { workflowStatus: updated.workflowStatus, reason: input.reason },
    });
    return { campaign: { id: campaign.id, workflowStatus: updated.workflowStatus } };
  });
}
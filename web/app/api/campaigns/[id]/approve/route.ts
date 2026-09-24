import { prisma } from "@admedic/database";
import { requireActor, requireRole } from "../../../../_lib/auth";
import { respond, sameOrigin, HttpError } from "../../../../_lib/http";
import { checkPolicy } from "@admedic/policy";
import { logAudit } from "../../../../_lib/audit";
import { ownedCampaign } from "../../../../_lib/campaign-workflow";

export const maxDuration = 15;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, ["OWNER", "ADMIN"]);
    const { id } = await params;
    const campaign = await ownedCampaign(actor, id);
    if (campaign.workflowStatus !== "IN_REVIEW")
      throw new HttpError(409, "Yalnızca incelemedeki kampanya onaylanabilir.");
    const policy = checkPolicy(campaign.name);
    if (policy.risk === "HIGH")
      throw new HttpError(422, "İçerik kontrolündeki yüksek riskli ifadeleri düzeltin.");
    const updated = await prisma.campaign.update({
      where: { id },
      data: {
        workflowStatus: "APPROVED",
        policyRisk: policy.risk,
        policyReport: policy,
        approvedBy: actor.userId,
        approvedAt: new Date(),
      },
    });
    await logAudit({
      actor,
      action: "CAMPAIGN_APPROVED",
      entityType: "CAMPAIGN",
      entityId: campaign.id,
      before: { workflowStatus: campaign.workflowStatus },
      after: { workflowStatus: updated.workflowStatus, approvedBy: actor.userId },
    });
    return { campaign: { id: campaign.id, workflowStatus: updated.workflowStatus } };
  });
}
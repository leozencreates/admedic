import { prisma } from "@admedic/database";
import { requireActor, requireRole, EDIT_ROLES } from "../../../../_lib/auth";
import { respond, sameOrigin, HttpError } from "../../../../_lib/http";
import { checkPolicyWithRules } from "../../../../_lib/policy-loader";
import { logAudit } from "../../../../_lib/audit";
import { ownedCampaign } from "../../../../_lib/campaign-workflow";

export const maxDuration = 15;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, EDIT_ROLES);
    const { id } = await params;
    const campaign = await ownedCampaign(actor, id);
    if (!["DRAFT", "REJECTED"].includes(campaign.workflowStatus))
      throw new HttpError(409, "Kampanya zaten incelemede veya daha ileri bir aşamada.");
    const policy = await checkPolicyWithRules(campaign.name);
    if (policy.risk === "HIGH")
      throw new HttpError(422, "İçerik kontrolündeki yüksek riskli ifadeleri düzeltin.");
    const updated = await prisma.campaign.update({
      where: { id },
      data: {
        workflowStatus: "IN_REVIEW",
        policyRisk: policy.risk,
        policyReport: policy,
        rejectionReason: null,
        rejectionBy: null,
      },
    });
    await logAudit({
      actor,
      action: "CAMPAIGN_SUBMITTED",
      entityType: "CAMPAIGN",
      entityId: campaign.id,
      before: { workflowStatus: campaign.workflowStatus, policyRisk: campaign.policyRisk },
      after: { workflowStatus: updated.workflowStatus, policyRisk: updated.policyRisk },
    });
    return { campaign: { id: campaign.id, workflowStatus: updated.workflowStatus } };
  });
}
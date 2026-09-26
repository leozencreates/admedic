import { prisma } from "@admedic/database";
import { requireActor, requireRole } from "../../../../_lib/auth";
import { respond, sameOrigin, HttpError } from "../../../../_lib/http";
import { checkPolicyWithRules } from "../../../../_lib/policy-loader";
import { logAudit } from "../../../../_lib/audit";
import {
  campaignPolicyText,
  clinicPolicyContext,
  lockCampaignRow,
  ownedCampaign,
} from "../../../../_lib/campaign-workflow";

export const maxDuration = 15;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, ["OWNER", "ADMIN"]);
    const { id } = await params;
    return prisma.$transaction(async (tx) => {
      await lockCampaignRow(tx, actor, id);
      const campaign = await ownedCampaign(actor, id, tx);
      if (campaign.workflowStatus !== "IN_REVIEW")
        throw new HttpError(409, "Yalnızca incelemedeki kampanya onaylanabilir.");
      // Onay anında güncel kural seti (sabit paket kuralları değil) ile yeniden kontrol (ADR-0008).
      const clinic = await clinicPolicyContext(actor.workspaceId, tx);
      const policy = await checkPolicyWithRules(campaignPolicyText(campaign), clinic.bannedPhrases, tx);
      if (policy.risk === "HIGH")
        throw new HttpError(422, "İçerik kontrolündeki yüksek riskli ifadeleri düzeltin.");
      const policyWarning =
        policy.risk === "MEDIUM" ? policy.findings.map((f) => f.reason).join("; ") : null;
      const moved = await tx.campaign.updateMany({
        where: { id, workspaceId: actor.workspaceId, workflowStatus: "IN_REVIEW" },
        data: {
          workflowStatus: "APPROVED",
          policyRisk: policy.risk,
          policyReport: policy,
          approvedBy: actor.userId,
          approvedAt: new Date(),
        },
      });
      if (moved.count !== 1)
        throw new HttpError(409, "Kampanya durumu eşzamanlı olarak değişti; yenileyip tekrar deneyin.");
      await logAudit({
        actor,
        action: "CAMPAIGN_APPROVED",
        entityType: "CAMPAIGN",
        entityId: campaign.id,
        before: { workflowStatus: campaign.workflowStatus, policyRisk: campaign.policyRisk },
        after: { workflowStatus: "APPROVED", approvedBy: actor.userId, policyRisk: policy.risk, policyWarning },
      }, tx);
      return { campaign: { id: campaign.id, workflowStatus: "APPROVED", policyRisk: policy.risk, policyWarning } };
    });
  });
}

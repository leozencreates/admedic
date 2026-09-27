import { prisma } from "@admedic/database";
import { requireActor, requireRole, EDIT_ROLES } from "../../../../_lib/auth";
import { respond, sameOrigin, HttpError } from "../../../../_lib/http";
import { checkPolicyWithRules } from "../../../../_lib/policy-loader";
import { logAudit } from "../../../../_lib/audit";
import {
  campaignPolicyText,
  clinicPolicyContext,
  lockCampaignRow,
  ownedCampaign,
} from "../../../../_lib/campaign-workflow";
import { publishReadiness } from "../../../../_lib/campaign-content";

export const maxDuration = 15;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, EDIT_ROLES);
    const { id } = await params;
    return prisma.$transaction(async (tx) => {
      // Yarış koruması: aynı kampanyaya eşzamanlı submit/approve/reject sıraya girer.
      await lockCampaignRow(tx, actor, id);
      const campaign = await ownedCampaign(actor, id, tx);
      if (!["DRAFT", "REJECTED"].includes(campaign.workflowStatus))
        throw new HttpError(409, "Kampanya zaten incelemede veya daha ileri bir aşamada.");
      // Kural setinin taze anlık görüntüsü + klinik yasaklı ifadeleri (spec 3.5).
      const clinic = await clinicPolicyContext(actor.workspaceId, tx);
      const policy = await checkPolicyWithRules(campaignPolicyText(campaign), clinic.bannedPhrases, tx);
      if (policy.risk === "HIGH")
        throw new HttpError(422, "İçerik kontrolündeki yüksek riskli ifadeleri düzeltin.");
      const policyWarning =
        policy.risk === "MEDIUM" ? policy.findings.map((f) => f.reason).join("; ") : null;
      // Planlı kampanya onaya ancak Meta'ya eksiksiz yayınlanabilir halde gider: onaylanan, yayınlanandır.
      if (campaign.plan) {
        const org = await tx.organization.findUniqueOrThrow({ where: { id: actor.orgId }, select: { privacyPolicyUrl: true } });
        const readiness = publishReadiness({
          objective: campaign.objective,
          plan: campaign.plan,
          content: campaign.content,
          imageHash: campaign.imageHash,
          privacyPolicyUrl: org.privacyPolicyUrl,
        });
        if (!readiness.ready) throw new HttpError(422, `Onaya göndermeden önce tamamlayın: ${readiness.reasons.join(" ")}`);
      }
      const moved = await tx.campaign.updateMany({
        where: { id, workspaceId: actor.workspaceId, workflowStatus: campaign.workflowStatus },
        data: {
          workflowStatus: "IN_REVIEW",
          policyRisk: policy.risk,
          policyReport: policy,
          rejectionReason: null,
          rejectionBy: null,
        },
      });
      if (moved.count !== 1)
        throw new HttpError(409, "Kampanya durumu eşzamanlı olarak değişti; yenileyip tekrar deneyin.");
      await logAudit({
        actor,
        action: "CAMPAIGN_SUBMITTED",
        entityType: "CAMPAIGN",
        entityId: campaign.id,
        before: { workflowStatus: campaign.workflowStatus, policyRisk: campaign.policyRisk },
        after: { workflowStatus: "IN_REVIEW", policyRisk: policy.risk, policyWarning },
      }, tx);
      return { campaign: { id: campaign.id, workflowStatus: "IN_REVIEW", policyRisk: policy.risk, policyWarning } };
    });
  });
}

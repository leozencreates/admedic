import { prisma } from "@admedic/database";
import { requireActor, requireRole, EDIT_ROLES } from "../../../../_lib/auth";
import { body, respond, sameOrigin, HttpError } from "../../../../_lib/http";
import { createMetaClient, MOCK_AD_ACCOUNT_ID } from "@admedic/meta-api";
import { checkPolicy } from "@admedic/policy";
import { z } from "zod";
import { logAudit } from "../../../../_lib/audit";
import { ownedCampaign } from "../../../../_lib/campaign-workflow";
import { requireLiveMetaConnection } from "../../../../_lib/meta-connection";

export const maxDuration = 15;

const PublishSchema = z
  .object({ action: z.enum(["PUBLISH", "PAUSE", "ACTIVATE", "ARCHIVE"]) })
  .strict();

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    const { id } = await params;
    const input = await body(request, PublishSchema);
    if (input.action === "ACTIVATE") requireRole(actor, ["OWNER", "ADMIN"]);
    else requireRole(actor, EDIT_ROLES);
    const campaign = await ownedCampaign(actor, id);
    const adAccount = campaign.adAccount;
    if (!adAccount?.connectionId)
      throw new HttpError(400, "Meta bağlantısı yapılandırılmadı.");
    const live = await requireLiveMetaConnection(adAccount.connectionId, actor.orgId);

    const meta = createMetaClient();
    const token = live.token;

    let workflowStatus = campaign.workflowStatus;
    let status = campaign.status;
    let metaCampaignId = campaign.metaCampaignId;
    let note: string | undefined;

    let policyWarning: string | null = null;
    let metaReviewStatus: string | undefined;
    let metaRejectionReason: unknown = undefined;
    if (input.action === "PUBLISH") {
      if (campaign.workflowStatus !== "APPROVED")
        throw new HttpError(409, "Kampanya henüz onaylanmadı.");
      if (campaign.metaCampaignId)
        throw new HttpError(409, "Kampanya zaten Meta'da yayınlandı.");
      const policy = checkPolicy(campaign.name);
      if (policy.risk === "HIGH")
        throw new HttpError(422, "İçerik kontrolündeki yüksek riskli ifadeleri düzeltin.");
      if (policy.risk === "MEDIUM") policyWarning = policy.findings.map((f) => f.reason).join("; ");
      const created = await meta.createCampaign(
        {
          accountId: (adAccount.metaAccountId ?? MOCK_AD_ACCOUNT_ID).replace(/^act_/, ""),
          name: campaign.name,
          objective: campaign.objective ?? "OUTCOME_LEADS",
          dailyBudgetCents: campaign.dailyBudget ? campaign.dailyBudget * 100 : undefined,
          status: "PAUSED",
        },
        token,
      );
      metaCampaignId = created.campaignId;
      if (created.reviewFeedbackGlobal && Object.keys(created.reviewFeedbackGlobal).length > 0) {
        metaReviewStatus = "DISAPPROVED";
        metaRejectionReason = { global: created.reviewFeedbackGlobal, placement_specific: created.reviewFeedbackPlacements };
      }
      workflowStatus = "PUBLISHED_PAUSED";
      status = "PAUSED";
      note = "Meta'da PAUSED olarak oluşturuldu.";
    } else if (input.action === "ACTIVATE") {
      if (campaign.workflowStatus !== "PUBLISHED_PAUSED" || !campaign.metaCampaignId)
        throw new HttpError(409, "Önce kampanyayı yayınlayın.");
      await meta.setStatus(
        { entityType: "campaign", entityId: campaign.metaCampaignId, status: "ACTIVE" },
        token,
      );
      workflowStatus = "ACTIVE";
      status = "ACTIVE";
      note = "Meta'da ACTIVE yapıldı.";
    } else if (input.action === "PAUSE") {
      if (campaign.workflowStatus !== "ACTIVE" || !campaign.metaCampaignId)
        throw new HttpError(409, "Yalnızca aktif kampanya duraklatılabilir.");
      await meta.setStatus(
        { entityType: "campaign", entityId: campaign.metaCampaignId, status: "PAUSED" },
        token,
      );
      workflowStatus = "PUBLISHED_PAUSED";
      status = "PAUSED";
      note = "Meta'da PAUSED yapıldı.";
    } else if (input.action === "ARCHIVE") {
      if (!["ACTIVE", "PUBLISHED_PAUSED"].includes(campaign.workflowStatus))
        throw new HttpError(409, "Yalnızca yayındaki kampanya arşivlenebilir.");
      workflowStatus = "ARCHIVED";
      status = "ARCHIVED";
      note = "Arşivlendi.";
    }

    await prisma.campaign.update({
      where: { id },
      data: {
        workflowStatus,
        status,
        metaCampaignId,
        syncedAt: new Date(),
        ...(metaReviewStatus ? { metaReviewStatus } : {}),
        ...(metaRejectionReason ? { metaRejectionReason } : {}),
        ...(policyWarning ? { metaRejectionReason: { warning: policyWarning } } : {}),
      },
    });
    await logAudit({
      actor,
      action: "CAMPAIGN_PUBLISHED",
      entityType: "CAMPAIGN",
      entityId: campaign.id,
      before: {
        status: campaign.status,
        workflowStatus: campaign.workflowStatus,
        metaCampaignId: campaign.metaCampaignId,
      },
      after: {
        status,
        workflowStatus,
        metaCampaignId,
        action: input.action,
        note,
        policyWarning,
      },
    });
    return {
      campaign: {
        id: campaign.id,
        name: campaign.name,
        status,
        workflowStatus,
        metaCampaignId,
        action: input.action,
        policyWarning,
      },
    };
  });
}
import { prisma } from "@admedic/database";
import { createMetaClient } from "@admedic/meta-api";
import { z } from "zod";
import { requireActor, requireRole, EDIT_ROLES } from "../../../../_lib/auth";
import { body, respond, sameOrigin, HttpError } from "../../../../_lib/http";
import { logAudit } from "../../../../_lib/audit";
import { lockCampaignRow, ownedCampaign } from "../../../../_lib/campaign-workflow";
import { activateCampaign, publishCampaign } from "../../../../_lib/campaign-publish";
import { requireLiveMetaConnection } from "../../../../_lib/meta-connection";

/** Tam yayın birden çok Meta çağrısı yapar; süre dolarsa ilerleme kaydedilir ve istemci devam ettirir. */
export const maxDuration = 60;

const PublishSchema = z
  .object({ action: z.enum(["PUBLISH", "PAUSE", "ACTIVATE", "ARCHIVE"]) })
  .strict();

/**
 * Kampanya yayın akışı (spec 3.3/3.6):
 * - PUBLISH: onaylı kampanyayı Meta'da eksiksiz ve PAUSED kurar (kampanya, ad set, lead formu,
 *   kreatif, reklam); yarım kalırsa aynı çağrı kaldığı yerden sürer. Harcama başlatmaz.
 * - ACTIVATE: harcamayı başlatır — yalnızca Owner veya Owner'ın harcama yetkisi verdiği üye, toplam
 *   aylık üst sınır içinde.
 * - PAUSE / ARCHIVE: harcamayı durdurur (EDIT rolleri).
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, EDIT_ROLES);
    const { id } = await params;
    const input = await body(request, PublishSchema);

    if (input.action === "PUBLISH") {
      const result = await publishCampaign(actor, id);
      const campaign = await ownedCampaign(actor, id);
      return {
        campaign: {
          id,
          name: campaign.name,
          status: campaign.status,
          workflowStatus: campaign.workflowStatus,
          metaCampaignId: result.metaCampaignId,
          action: input.action,
          policyWarning: result.policyWarning,
          ...(result.metaReviewStatus ? { metaReviewStatus: result.metaReviewStatus } : {}),
        },
        publish: { status: result.status, progress: result.progress, warnings: result.warnings },
      };
    }

    if (input.action === "ACTIVATE") {
      const result = await activateCampaign(actor, id);
      const campaign = await ownedCampaign(actor, id);
      return {
        campaign: {
          id,
          name: campaign.name,
          status: campaign.status,
          workflowStatus: campaign.workflowStatus,
          metaCampaignId: campaign.metaCampaignId,
          action: input.action,
          policyWarning: result.policyWarning,
          adsActivated: result.adsActivated,
          adSetsActivated: result.adSetsActivated,
        },
      };
    }

    // PAUSE / ARCHIVE: harcamayı durdurur; Meta çağrısı transaction dışında, yazım kısa transaction'da.
    const campaign = await ownedCampaign(actor, id);
    const partialPublish = campaign.workflowStatus === "APPROVED" && Boolean(campaign.metaCampaignId);
    if (input.action === "PAUSE") {
      if (campaign.workflowStatus !== "ACTIVE" || !campaign.metaCampaignId)
        throw new HttpError(409, "Yalnızca aktif kampanya duraklatılabilir.");
    } else {
      if (!["ACTIVE", "PUBLISHED_PAUSED"].includes(campaign.workflowStatus) && !partialPublish)
        throw new HttpError(409, "Yalnızca yayındaki (veya yayını yarım kalmış) kampanya arşivlenebilir.");
      if (!campaign.metaCampaignId) throw new HttpError(409, "Kampanyanın Meta kimliği bulunamadı.");
      if (partialPublish && campaign.publishLockedUntil && campaign.publishLockedUntil > new Date())
        throw new HttpError(409, "Yayın şu anda sürüyor; bitmesini bekleyip tekrar deneyin.");
    }
    if (!campaign.adAccount?.connectionId) throw new HttpError(400, "Meta bağlantısı yapılandırılmadı.");
    const live = await requireLiveMetaConnection(campaign.adAccount.connectionId, actor.orgId);
    const paused = await createMetaClient().setStatus(
      { entityType: "campaign", entityId: campaign.metaCampaignId!, status: "PAUSED" },
      live.token,
    );
    if (!paused.success)
      throw new HttpError(
        502,
        input.action === "PAUSE" ? "Meta duraklatma işlemi başarısız." : "Meta duraklatılamadığı için arşivleme yapılmadı.",
      );
    const workflowStatus = input.action === "PAUSE" ? "PUBLISHED_PAUSED" : "ARCHIVED";
    const status = input.action === "PAUSE" ? "PAUSED" : "ARCHIVED";
    const note =
      input.action === "PAUSE" ? "Meta'da PAUSED yapıldı." : "Meta'da duraklatıldı ve yerel olarak arşivlendi.";

    await prisma.$transaction(async (tx) => {
      await lockCampaignRow(tx, actor, id);
      const moved = await tx.campaign.updateMany({
        where: {
          id,
          workspaceId: actor.workspaceId,
          workflowStatus: campaign.workflowStatus,
          metaCampaignId: campaign.metaCampaignId,
        },
        data: {
          workflowStatus,
          status,
          syncedAt: new Date(),
          ...(input.action === "ARCHIVE" ? { publishLockedUntil: null } : {}),
        },
      });
      if (moved.count !== 1)
        throw new HttpError(409, "Kampanya durumu eşzamanlı olarak değişti; yenileyip tekrar deneyin.");
      await logAudit({
        actor,
        action: input.action === "PAUSE" ? "CAMPAIGN_PAUSED" : "CAMPAIGN_ARCHIVED",
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
          metaCampaignId: campaign.metaCampaignId,
          action: input.action,
          note,
          ...(partialPublish ? { partialPublish: true } : {}),
        },
      }, tx);
    }, { timeout: 10_000 });

    return {
      campaign: {
        id: campaign.id,
        name: campaign.name,
        status,
        workflowStatus,
        metaCampaignId: campaign.metaCampaignId,
        action: input.action,
        policyWarning: null,
      },
    };
  });
}

import { prisma, type Prisma } from "@admedic/database";
import { requireActor, requireRole, EDIT_ROLES } from "../../../../_lib/auth";
import { body, respond, sameOrigin, HttpError } from "../../../../_lib/http";
import { createMetaClient, MOCK_AD_ACCOUNT_ID } from "@admedic/meta-api";
import { checkPolicyWithRules } from "../../../../_lib/policy-loader";
import { z } from "zod";
import { logAudit } from "../../../../_lib/audit";
import {
  campaignPolicyText,
  clinicPolicyContext,
  lockCampaignRow,
  ownedCampaign,
} from "../../../../_lib/campaign-workflow";
import { requireLiveMetaConnection } from "../../../../_lib/meta-connection";

export const maxDuration = 30;

const PublishSchema = z
  .object({ action: z.enum(["PUBLISH", "PAUSE", "ACTIVATE", "ARCHIVE"]) })
  .strict();

type PublishAction = z.infer<typeof PublishSchema>["action"];

const AUDIT_ACTION: Record<PublishAction, string> = {
  PUBLISH: "CAMPAIGN_PUBLISHED",
  ACTIVATE: "CAMPAIGN_ACTIVATED",
  PAUSE: "CAMPAIGN_PAUSED",
  ARCHIVE: "CAMPAIGN_ARCHIVED",
};

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    const { id } = await params;
    const input = await body(request, PublishSchema);
    if (input.action === "ACTIVATE") requireRole(actor, ["OWNER", "ADMIN"]);
    else requireRole(actor, EDIT_ROLES);

    // 1) Yerel kontrol (transaction dışı): durum, politika, bütçe üst sınırı.
    const campaign = await ownedCampaign(actor, id);
    const adAccount = campaign.adAccount;
    if (!adAccount?.connectionId)
      throw new HttpError(400, "Meta bağlantısı yapılandırılmadı.");
    const live = await requireLiveMetaConnection(adAccount.connectionId, actor.orgId);
    const token = live.token;
    const meta = createMetaClient();

    let workflowStatus = campaign.workflowStatus;
    let status = campaign.status;
    let metaCampaignId = campaign.metaCampaignId;
    let note: string | undefined;
    let policyWarning: string | null = null;
    let metaReviewStatus: string | undefined;
    let metaRejectionReason: Prisma.InputJsonValue | undefined;

    // PUBLISH ve ACTIVATE harcamayı başlatır: taze kural seti + klinik yasaklı ifadeleriyle yeniden kontrol.
    if (input.action === "PUBLISH" || input.action === "ACTIVATE") {
      if (input.action === "PUBLISH") {
        if (campaign.workflowStatus !== "APPROVED")
          throw new HttpError(409, "Kampanya henüz onaylanmadı.");
        if (campaign.metaCampaignId)
          throw new HttpError(409, "Kampanya zaten Meta'da yayınlandı.");
      } else if (campaign.workflowStatus !== "PUBLISHED_PAUSED" || !campaign.metaCampaignId) {
        throw new HttpError(409, "Önce kampanyayı yayınlayın.");
      }
      const clinic = await clinicPolicyContext(actor.workspaceId);
      const policy = await checkPolicyWithRules(campaignPolicyText(campaign), clinic.bannedPhrases);
      if (policy.risk === "HIGH")
        throw new HttpError(422, "İçerik kontrolündeki yüksek riskli ifadeleri düzeltin.");
      if (policy.risk === "MEDIUM") policyWarning = policy.findings.map((f) => f.reason).join("; ");
      const org = await prisma.organization.findUniqueOrThrow({ where: { id: actor.orgId } });
      // Aylık üst sınır: ikisi de minor unit (ADR-0011).
      if (org.monthlyAdBudgetCap != null && (campaign.dailyBudget ?? 0) * 30 > org.monthlyAdBudgetCap)
        throw new HttpError(422, "Kampanya bütçesi kuruluşun aylık üst sınırını aşıyor.");
    }

    // 2) Meta çağrısı (transaction DIŞINDA; uzun süren dış çağrı kilit tutmaz).
    if (input.action === "PUBLISH") {
      // Canlı modda mock hesaba düşülmez: gerçek hesap kimliği zorunlu.
      const rawAccountId = adAccount.metaAccountId ?? (live.mockMode ? MOCK_AD_ACCOUNT_ID : null);
      if (!rawAccountId)
        throw new HttpError(400, "Reklam hesabının Meta kimliği (metaAccountId) tanımlı değil.");
      const plan = campaign.plan as { strategy?: unknown } | null;
      const budgetStrategy = plan?.strategy === "ABO" ? "ABO" : plan?.strategy === "CBO" ? "CBO" : undefined;
      const created = await meta.createCampaign(
        {
          accountId: rawAccountId.replace(/^act_/, ""),
          name: campaign.name,
          objective: campaign.objective ?? "OUTCOME_LEADS",
          // DB minor unit tutar; Meta'ya dönüşümsüz gider (ADR-0011).
          dailyBudgetCents: campaign.dailyBudget ?? undefined,
          budgetStrategy,
          status: "PAUSED",
        },
        token,
      );
      if (!created.success || !created.campaignId)
        throw new HttpError(502, "Meta kampanya oluşturma işlemi başarısız.");
      metaCampaignId = created.campaignId;
      if (created.reviewFeedbackGlobal && Object.keys(created.reviewFeedbackGlobal).length > 0) {
        metaReviewStatus = "DISAPPROVED";
        metaRejectionReason = {
          global: created.reviewFeedbackGlobal,
          placement_specific: created.reviewFeedbackPlacements ?? {},
        } as Prisma.InputJsonValue;
      }
      workflowStatus = "PUBLISHED_PAUSED";
      status = "PAUSED";
      note = "Meta'da PAUSED olarak oluşturuldu.";
    } else if (input.action === "ACTIVATE") {
      const activated = await meta.setStatus(
        { entityType: "campaign", entityId: campaign.metaCampaignId!, status: "ACTIVE" },
        token,
      );
      if (!activated.success) throw new HttpError(502, "Meta etkinleştirme işlemi başarısız.");
      workflowStatus = "ACTIVE";
      status = "ACTIVE";
      note = "Meta'da ACTIVE yapıldı.";
    } else if (input.action === "PAUSE") {
      if (campaign.workflowStatus !== "ACTIVE" || !campaign.metaCampaignId)
        throw new HttpError(409, "Yalnızca aktif kampanya duraklatılabilir.");
      const paused = await meta.setStatus(
        { entityType: "campaign", entityId: campaign.metaCampaignId, status: "PAUSED" },
        token,
      );
      if (!paused.success) throw new HttpError(502, "Meta duraklatma işlemi başarısız.");
      workflowStatus = "PUBLISHED_PAUSED";
      status = "PAUSED";
      note = "Meta'da PAUSED yapıldı.";
    } else if (input.action === "ARCHIVE") {
      if (!["ACTIVE", "PUBLISHED_PAUSED"].includes(campaign.workflowStatus))
        throw new HttpError(409, "Yalnızca yayındaki kampanya arşivlenebilir.");
      if (!campaign.metaCampaignId)
        throw new HttpError(409, "Kampanyanın Meta kimliği bulunamadı.");
      const paused = await meta.setStatus(
        { entityType: "campaign", entityId: campaign.metaCampaignId, status: "PAUSED" }, token,
      );
      if (!paused.success) throw new HttpError(502, "Meta duraklatılamadığı için arşivleme yapılmadı.");
      workflowStatus = "ARCHIVED";
      status = "ARCHIVED";
      note = "Meta'da duraklatıldı ve yerel olarak arşivlendi.";
    }

    const auditAfter = {
      status,
      workflowStatus,
      metaCampaignId,
      action: input.action,
      note,
      // Orta risk uyarısı yalnızca audit + yanıtta; metaRejectionReason gerçek Meta geri bildirimine ayrılmıştır.
      policyWarning,
      ...(metaReviewStatus ? { metaReviewStatus } : {}),
    };

    // 3) Kısa transaction: satır kilidi + beklenen durumla korunan yazım + audit.
    try {
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
            metaCampaignId,
            syncedAt: new Date(),
            ...(metaReviewStatus ? { metaReviewStatus } : {}),
            ...(metaRejectionReason ? { metaRejectionReason } : {}),
          },
        });
        if (moved.count !== 1)
          throw new HttpError(409, "Kampanya durumu eşzamanlı olarak değişti; yenileyip tekrar deneyin.");
        await logAudit({
          actor,
          action: AUDIT_ACTION[input.action],
          entityType: "CAMPAIGN",
          entityId: campaign.id,
          before: {
            status: campaign.status,
            workflowStatus: campaign.workflowStatus,
            metaCampaignId: campaign.metaCampaignId,
          },
          after: auditAfter,
        }, tx);
      }, { timeout: 10_000 });
    } catch (error) {
      if (input.action === "PUBLISH" && metaCampaignId) {
        // Meta'da kampanya oluştu ama yerel kayıt yazılamadı: yetim kaydı denetime işle.
        console.error(`[campaign-publish] yetim Meta kampanyası: ${metaCampaignId} (yerel ${campaign.id})`);
        try {
          await logAudit({
            actor,
            action: "CAMPAIGN_PUBLISH_ORPHANED",
            entityType: "CAMPAIGN",
            entityId: campaign.id,
            before: { workflowStatus: campaign.workflowStatus, metaCampaignId: campaign.metaCampaignId },
            after: {
              metaCampaignId,
              warning: "Meta'da PAUSED kampanya oluşturuldu ancak yerel kayıt güncellenemedi; elle eşleştirin veya Meta'da silin.",
            },
          });
        } catch {
          // Denetim kaydı da yazılamadı; konsol satırı tek iz.
        }
        if (error instanceof HttpError) throw error;
        throw new HttpError(
          503,
          `Meta'da kampanya oluşturuldu (${metaCampaignId}) ancak yerel kayıt güncellenemedi; destek ile eşleştirin.`,
        );
      }
      throw error;
    }

    return {
      campaign: {
        id: campaign.id,
        name: campaign.name,
        status,
        workflowStatus,
        metaCampaignId,
        action: input.action,
        policyWarning,
        ...(metaReviewStatus ? { metaReviewStatus } : {}),
      },
    };
  });
}

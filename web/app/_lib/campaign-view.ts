/**
 * Kampanya görünümü (planlayıcı listesi, kampanya sayfası; ADR-0020): iş akışı, içerik özeti, yayın ilerlemesi,
 * hazırlık denetimi ve Meta incelemesi tek biçimde döner. Sunucu modülüdür.
 */
import { prisma, type Prisma } from "@admedic/database";
import type { Actor } from "./auth";
import { publishReadiness } from "./campaign-content";
import { summarizeContent } from "./campaign-content-attach";
import { summarizePublishProgress } from "./campaign-publish";

const READINESS_STATUSES = ["DRAFT", "REJECTED", "IN_REVIEW", "APPROVED"];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Reklam düzeyi Meta inceleme özeti (ADR-0015): durum + sorunlu reklamlar ve gerekçeleri. */
export function reviewSummary(status: string | null, checkedAt: Date | null, reason: unknown) {
  if (!status) return null;
  const detail = isRecord(reason) ? reason : {};
  const summary = isRecord(detail.summary) ? detail.summary : {};
  const ads = Array.isArray(detail.ads) ? detail.ads.filter(isRecord) : [];
  return {
    status,
    checkedAt,
    disapproved: typeof summary.disapproved === "number" ? summary.disapproved : 0,
    withIssues: typeof summary.withIssues === "number" ? summary.withIssues : 0,
    pending: typeof summary.pending === "number" ? summary.pending : 0,
    total: typeof summary.total === "number" ? summary.total : null,
    ads: ads.slice(0, 10).map((ad) => ({
      name: typeof ad.name === "string" ? ad.name : "",
      effectiveStatus: typeof ad.effectiveStatus === "string" ? ad.effectiveStatus : null,
      reasons: Array.isArray(ad.reasons) ? ad.reasons.filter((r): r is string => typeof r === "string").slice(0, 5) : [],
    })),
  };
}


/** Çalışma alanının kampanyaları (isteğe bağlı ek süzgeçle), en yenisi önce. */
export async function loadCampaignViews(actor: Actor, where: Prisma.CampaignWhereInput = {}) {
    const [campaigns, org] = await Promise.all([
      prisma.campaign.findMany({
        where: { ...where, workspaceId: actor.workspaceId },
        orderBy: { createdAt: "desc" },
        include: {
          adAccount: { select: { currency: true } },
          adsets: {
            select: {
              metaAdSetId: true,
              targeting: true,
              _count: { select: { ads: { where: { metaAdId: { not: null } } } } },
            },
          },
        },
      }),
      prisma.organization.findUniqueOrThrow({ where: { id: actor.orgId }, select: { privacyPolicyUrl: true } }),
    ]);
    return campaigns.map(({ adsets, adAccount, content, publishState, ...c }) => {
        const publishedAds = adsets.reduce((sum, a) => sum + a._count.ads, 0);
        const readiness =
          c.plan && READINESS_STATUSES.includes(c.workflowStatus)
            ? publishReadiness({
                objective: c.objective,
                plan: c.plan,
                content,
                imageHash: c.imageHash,
                privacyPolicyUrl: org.privacyPolicyUrl,
              })
            : null;
        return {
          ...c,
          adSets: adsets.length,
          ads: publishedAds,
          // dailyBudget minor unit'tir; okunabilirlik için açık adla da döner.
          budgetCents: c.dailyBudget,
          currency: adAccount.currency,
          content: summarizeContent(content),
          review: reviewSummary(c.metaReviewStatus, c.metaReviewCheckedAt, c.metaRejectionReason),
          readiness: readiness
            ? { ready: readiness.ready, reasons: readiness.reasons, warnings: readiness.warnings }
            : null,
          publish: summarizePublishProgress({
            metaCampaignId: c.metaCampaignId,
            workflowStatus: c.workflowStatus,
            publishState,
            content,
            adSets: adsets,
            publishedAds,
          }),
        };
      });
}

export type CampaignView = Awaited<ReturnType<typeof loadCampaignViews>>[number];

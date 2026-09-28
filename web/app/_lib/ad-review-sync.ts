import { applyAdReviewSync, prisma } from "@admedic/database";
import { buildAdReviewSync, createMetaClient, type MetaClientLike } from "@admedic/meta-api";
import { isAdmedicError } from "@admedic/shared";
import { HttpError } from "./http";
import { requireLiveMetaConnection } from "./meta-connection";

/**
 * Kampanyanın Meta'daki reklamlarının inceleme durumunu senkronlar (spec 3.5; ADR-0015): reklam başına
 * `effective_status` + `ad_review_feedback` + `issues_info` okunur, `applyAdReviewSync` ile yazılır
 * (yeni red → AD_DISAPPROVED uyarısı). Worker aynı işi zamanlanmış olarak yapar; bu uç elle yenileme içindir.
 */

export interface CampaignReviewSyncResult {
  campaignId: string;
  name: string;
  /** Toplam durum; reklam yoksa NO_ADS, bağlantı/Meta hatasında ERROR. */
  status: string;
  ads: number;
  newlyDisapproved: number;
  error?: string;
}

export async function syncCampaignAdReviews(
  campaign: { id: string; name: string; adAccount: { connectionId: string | null } },
  orgId: string,
  meta: MetaClientLike = createMetaClient(),
): Promise<CampaignReviewSyncResult> {
  const base = { campaignId: campaign.id, name: campaign.name, newlyDisapproved: 0 };
  const ads = await prisma.ad.findMany({
    where: { adSet: { campaignId: campaign.id }, metaAdId: { not: null } },
    select: { metaAdId: true },
  });
  const ids = ads.map((a) => a.metaAdId!).filter(Boolean);
  if (ids.length === 0) return { ...base, status: "NO_ADS", ads: 0 };
  if (!campaign.adAccount.connectionId)
    return { ...base, status: "ERROR", ads: ids.length, error: "Meta bağlantısı kurulmamış. Meta bağlantıları sayfasından Meta ile bağlantı kurun." };
  let token: string;
  try {
    token = (await requireLiveMetaConnection(campaign.adAccount.connectionId, orgId)).token;
  } catch (error) {
    return {
      ...base,
      status: "ERROR",
      ads: ids.length,
      error: error instanceof HttpError ? error.message : "Meta bağlantısı aktif değil.",
    };
  }
  try {
    const reviews = await meta.getAdReviews(ids, token);
    const applied = await applyAdReviewSync(prisma, { campaignId: campaign.id, ...buildAdReviewSync(reviews) });
    return {
      ...base,
      status: applied.status ?? "UNKNOWN",
      ads: applied.updated,
      newlyDisapproved: applied.newlyDisapproved.length,
    };
  } catch (error) {
    return {
      ...base,
      status: "ERROR",
      ads: ids.length,
      error: isAdmedicError(error) ? error.message.slice(0, 300) : "Meta inceleme sorgusu başarısız.",
    };
  }
}

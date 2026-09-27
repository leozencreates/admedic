import { Prisma, type PrismaClient } from "@prisma/client";

/**
 * Reklam düzeyinde Meta inceleme senkronunun veritabanı tarafı (spec 3.5 — Meta red raporu).
 * Girdi, `@admedic/meta-api` `buildAdReviewSync` çıktısıdır (bu paket meta-api'ye bağımlı değildir; şekil yapısal).
 * Web (elle senkron) ve worker (zamanlanmış senkron) aynı fonksiyonu kullanır.
 *
 * - Her reklamın `metaEffectiveStatus` / `metaReviewFeedback` / `metaReviewCheckedAt` alanları yazılır.
 * - Yeni reddedilen reklam için AD_DISAPPROVED uyarısı (açık uyarı varsa tekrar yok) ve
 *   `META_AD_DISAPPROVED` denetim kaydı (gerekçeler append-only; kural iyileştirme raporu için) düşülür.
 * - Red kalkan reklamın açık uyarısı çözülür.
 * - Kampanyaya toplam durum (`metaReviewStatus`) ve sorunlu reklamların gerekçeleri (`metaRejectionReason`) yazılır.
 * Aynı kampanya için eşzamanlı senkronlar danışma kilidiyle sıralanır (uyarı iki kez oluşmaz).
 */

export type AdReviewStateValue = "DISAPPROVED" | "WITH_ISSUES" | "PENDING_REVIEW" | "OK" | "UNKNOWN";

export interface AdReviewSyncItemInput {
  metaAdId: string;
  effectiveStatus: string | null;
  configuredStatus: string | null;
  state: AdReviewStateValue;
  feedback: {
    global: Record<string, string>;
    placements: Record<string, Record<string, string>>;
    issues: Array<{ code: number | null; summary: string | null; message: string | null; level: string | null }>;
  } | null;
  reasons: string[];
}

export interface AdReviewSyncInput {
  campaignId: string;
  items: AdReviewSyncItemInput[];
  summary: { status: string; total: number; disapproved: number; withIssues: number; pending: number };
  checkedAt?: Date;
}

export interface AdReviewSyncResult {
  /** Kampanyaya yazılan toplam durum; kampanya bulunamazsa null. */
  status: string | null;
  updated: number;
  alertsCreated: number;
  alertsResolved: number;
  /** Bu senkronda yeni reddedilen reklamların yerel kimlikleri. */
  newlyDisapproved: string[];
}

const EMPTY: AdReviewSyncResult = { status: null, updated: 0, alertsCreated: 0, alertsResolved: 0, newlyDisapproved: [] };

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

export async function applyAdReviewSync(db: PrismaClient, input: AdReviewSyncInput): Promise<AdReviewSyncResult> {
  const now = input.checkedAt ?? new Date();
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.campaignId}), hashtext('ad-review'))`;
      const campaign = await tx.campaign.findUnique({
        where: { id: input.campaignId },
        select: { id: true, name: true, workspaceId: true, adAccount: { select: { orgId: true } } },
      });
      if (!campaign) return EMPTY;
      const metaIds = input.items.map((i) => i.metaAdId);
      const ads = metaIds.length
        ? await tx.ad.findMany({
            where: { adSet: { campaignId: campaign.id }, metaAdId: { in: metaIds } },
            select: { id: true, name: true, metaAdId: true, metaEffectiveStatus: true, workspaceId: true },
          })
        : [];
      const byMetaId = new Map(ads.map((ad) => [ad.metaAdId, ad]));
      const workspaceId = campaign.workspaceId;
      const result: AdReviewSyncResult = { ...EMPTY, newlyDisapproved: [] };
      const problemAds: Array<Record<string, unknown>> = [];

      for (const item of input.items) {
        const ad = byMetaId.get(item.metaAdId);
        if (!ad) continue;
        const wasDisapproved = ad.metaEffectiveStatus === "DISAPPROVED";
        await tx.ad.update({
          where: { id: ad.id },
          data: {
            metaEffectiveStatus: item.effectiveStatus,
            metaReviewFeedback: item.feedback ? json(item.feedback) : Prisma.DbNull,
            metaReviewCheckedAt: now,
          },
        });
        result.updated++;
        if (item.state === "DISAPPROVED" || item.state === "WITH_ISSUES")
          problemAds.push({
            adId: ad.id,
            metaAdId: item.metaAdId,
            name: ad.name,
            effectiveStatus: item.effectiveStatus,
            reasons: item.reasons,
            ...(item.feedback ?? {}),
          });
        if (!workspaceId) continue;

        if (item.state === "DISAPPROVED" && !wasDisapproved) {
          result.newlyDisapproved.push(ad.id);
          const open = await tx.alert.findFirst({
            where: { workspaceId, type: "AD_DISAPPROVED", entityId: ad.id, status: "OPEN" },
            select: { id: true },
          });
          if (!open) {
            const reasons = item.reasons.length > 0 ? item.reasons.join("; ") : "Meta gerekçe bildirmedi.";
            await tx.alert.create({
              data: {
                workspaceId,
                type: "AD_DISAPPROVED",
                severity: "CRITICAL",
                title: `Meta reklamı reddetti: ${ad.name}`.slice(0, 200),
                message: `Kampanya "${campaign.name}" — gerekçe: ${reasons}`.slice(0, 1000),
                entityType: "AD",
                entityId: ad.id,
              },
            });
            result.alertsCreated++;
          }
          await tx.auditLog.create({
            data: {
              orgId: campaign.adAccount.orgId,
              workspaceId,
              userId: null,
              action: "META_AD_DISAPPROVED",
              entityType: "AD",
              entityId: ad.id,
              after: json({
                campaignId: campaign.id,
                metaAdId: item.metaAdId,
                effectiveStatus: item.effectiveStatus,
                reasons: item.reasons,
                feedback: item.feedback,
              }),
            },
          });
        } else if (item.state !== "DISAPPROVED" && wasDisapproved) {
          const resolved = await tx.alert.updateMany({
            where: { workspaceId, type: "AD_DISAPPROVED", entityId: ad.id, status: { in: ["OPEN", "ACKED"] } },
            data: { status: "RESOLVED", resolvedAt: now },
          });
          result.alertsResolved += resolved.count;
        }
      }

      await tx.campaign.update({
        where: { id: campaign.id },
        data: {
          metaReviewStatus: input.summary.status,
          metaRejectionReason:
            problemAds.length > 0
              ? json({ checkedAt: now.toISOString(), summary: input.summary, ads: problemAds.slice(0, 50) })
              : Prisma.DbNull,
          metaReviewCheckedAt: now,
        },
      });
      result.status = input.summary.status;
      return result;
    },
    { timeout: 30_000, maxWait: 10_000 },
  );
}

import { prisma } from "@admedic/database";
import { requireActor } from "../../../_lib/auth";
import { HttpError, respond } from "../../../_lib/http";
import { loadCampaignViews } from "../../../_lib/campaign-view";
import { EMPTY_METRICS, campaignBreakdown, sinceDays, sumMetrics } from "../../../_lib/campaign-metrics";

export const maxDuration = 15;

/**
 * Tek kampanya (ADR-0020, kampanya sayfası): planlayıcıyla aynı kampanya görünümü + reklam setleri,
 * 7/30 günlük performans (reklam/ad set/kampanya düzeyindeki anlık görüntüler kampanyaya toplanır),
 * günlük seri ve kampanyaya, reklam setlerine ya da reklamlarına ait ajan kararları ve bütçe değişiklikleri.
 * Salt okunur; çalışma alanı dışındaki kampanya 404.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    const actor = await requireActor();
    const { id } = await params;
    const [campaign] = await loadCampaignViews(actor, { id });
    if (!campaign) throw new HttpError(404, "Kampanya bulunamadı; silinmiş olabilir. Kampanyalar sayfasından yeniden açın.");

    const adSets = await prisma.adSet.findMany({
      where: { campaignId: id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true, name: true, status: true, dailyBudget: true, lifetimeBudget: true, metaAdSetId: true, targeting: true,
        ads: { select: { id: true, name: true } },
      },
    });
    const adIds = adSets.flatMap((a) => a.ads.map((ad) => ad.id));
    const targetIds = [id, ...adSets.map((a) => a.id), ...adIds];
    const [breakdown, decisions, budgetChanges] = await Promise.all([
      campaignBreakdown(actor.workspaceId, id, sinceDays(30)),
      prisma.agentDecision.findMany({
        where: { workspaceId: actor.workspaceId, targetId: { in: targetIds } },
        orderBy: { createdAt: "desc" },
        take: 30,
        select: {
          id: true, targetType: true, targetId: true, action: true, approval: true, reason: true,
          budgetBefore: true, budgetAfter: true, changePct: true, createdAt: true, appliedAt: true,
        },
      }),
      prisma.budgetChange.findMany({
        where: { workspaceId: actor.workspaceId, targetId: { in: targetIds } },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: { id: true, targetType: true, targetId: true, fromCents: true, toCents: true, status: true, createdAt: true, appliedAt: true },
      }),
    ]);
    const names = new Map<string, string>([
      [id, campaign.name],
      ...adSets.map((a) => [a.id, a.name] as [string, string]),
      ...adSets.flatMap((a) => a.ads.map((ad) => [ad.id, ad.name] as [string, string])),
    ]);
    return {
      campaign,
      adSets: adSets.map(({ ads, ...a }) => ({
        ...a,
        ads: ads.length,
        metrics30: breakdown.byAdSet.get(a.id) ?? EMPTY_METRICS,
      })),
      // 30 günlük toplam kırılımın kendisi; 7 günlük toplam aynı günlük seriden (tek sorgu, aynı kural).
      metrics: { days7: sumMetrics(breakdown.daily.filter((d) => d.date >= sinceDays(7).toISOString().slice(0, 10))), days30: breakdown.total },
      daily: breakdown.daily,
      decisions: decisions.map((d) => ({ ...d, targetName: names.get(d.targetId) ?? null })),
      budgetChanges: budgetChanges.map((b) => ({ ...b, targetName: names.get(b.targetId) ?? null })),
    };
  });
}

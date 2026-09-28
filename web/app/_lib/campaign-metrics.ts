/**
 * Kampanya performansı (ADR-0020): Meta insight anlık görüntüleri reklam, reklam seti ya da kampanya düzeyinde
 * saklanır (senkron hangi düzeyde çekildiyse). Kampanya toplamı için hepsi kampanyaya toplanır. Aynı gün için
 * hem kampanya düzeyi hem alt düzey satır varsa çift sayılmasın diye her kampanyada en üst mevcut düzey kullanılır.
 * Sunucu modülüdür. Tutarlar minor unit.
 */
import { prisma } from "@admedic/database";

export interface Metrics {
  spend: number;
  impressions: number;
  clicks: number;
  leads: number;
  purchases: number;
  conversionValue: number;
}

export const EMPTY_METRICS: Metrics = { spend: 0, impressions: 0, clicks: 0, leads: 0, purchases: 0, conversionValue: 0 };

type Level = "campaign" | "adset" | "ad";
const LEVEL_RANK: Record<Level, number> = { campaign: 0, adset: 1, ad: 2 };

function add(a: Metrics, b: Partial<Record<keyof Metrics, number | null>>): Metrics {
  return {
    spend: a.spend + (b.spend ?? 0),
    impressions: a.impressions + (b.impressions ?? 0),
    clicks: a.clicks + (b.clicks ?? 0),
    leads: a.leads + (b.leads ?? 0),
    purchases: a.purchases + (b.purchases ?? 0),
    conversionValue: a.conversionValue + (b.conversionValue ?? 0),
  };
}

interface Row {
  level: Level;
  campaignId: string;
  adSetId: string | null;
  date: string;
  sums: Partial<Record<keyof Metrics, number | null>>;
}

/** Anlık görüntü satırlarını kampanya (ve reklam seti) kimliğine bağlar. */
async function resolvedRows(workspaceId: string, since: Date, campaignIds?: string[]): Promise<Row[]> {
  const grouped = await prisma.insightSnapshot.groupBy({
    by: ["campaignId", "adSetId", "adId", "date"],
    where: { workspaceId, date: { gte: since } },
    _sum: { spend: true, impressions: true, clicks: true, leads: true, purchases: true, conversionValue: true },
  });
  const adIds = [...new Set(grouped.filter((g) => g.adId).map((g) => g.adId!))];
  const adSetIds = [...new Set(grouped.filter((g) => !g.adId && g.adSetId).map((g) => g.adSetId!))];
  const [ads, adSets] = await Promise.all([
    adIds.length
      ? prisma.ad.findMany({ where: { workspaceId, id: { in: adIds } }, select: { id: true, adSetId: true, adSet: { select: { campaignId: true } } } })
      : [],
    adSetIds.length ? prisma.adSet.findMany({ where: { workspaceId, id: { in: adSetIds } }, select: { id: true, campaignId: true } }) : [],
  ]);
  const adMap = new Map(ads.map((a) => [a.id, { adSetId: a.adSetId, campaignId: a.adSet.campaignId }]));
  const adSetMap = new Map(adSets.map((a) => [a.id, a.campaignId]));
  const wanted = campaignIds ? new Set(campaignIds) : null;
  const rows: Row[] = [];
  for (const g of grouped) {
    let level: Level;
    let campaignId: string | undefined;
    let adSetId: string | null = null;
    if (g.adId) {
      level = "ad";
      const ad = adMap.get(g.adId);
      campaignId = g.campaignId ?? ad?.campaignId;
      adSetId = g.adSetId ?? ad?.adSetId ?? null;
    } else if (g.adSetId) {
      level = "adset";
      campaignId = g.campaignId ?? adSetMap.get(g.adSetId);
      adSetId = g.adSetId;
    } else if (g.campaignId) {
      level = "campaign";
      campaignId = g.campaignId;
    } else continue;
    if (!campaignId || (wanted && !wanted.has(campaignId))) continue;
    rows.push({ level, campaignId, adSetId, date: g.date.toISOString().slice(0, 10), sums: g._sum });
  }
  // Her kampanya ve gün için yalnızca en üst mevcut düzey sayılır (çift sayım olmasın).
  const topLevel = new Map<string, number>();
  for (const r of rows) {
    const key = `${r.campaignId}|${r.date}`;
    topLevel.set(key, Math.min(topLevel.get(key) ?? 9, LEVEL_RANK[r.level]));
  }
  return rows.filter((r) => LEVEL_RANK[r.level] === topLevel.get(`${r.campaignId}|${r.date}`));
}

/** Kampanya kimliği → toplam metrikler (`since` gününden bugüne). */
export async function campaignMetrics(workspaceId: string, since: Date, campaignIds?: string[]): Promise<Map<string, Metrics>> {
  const out = new Map<string, Metrics>();
  for (const r of await resolvedRows(workspaceId, since, campaignIds)) out.set(r.campaignId, add(out.get(r.campaignId) ?? EMPTY_METRICS, r.sums));
  return out;
}

/** Tek kampanya: günlük seri ve reklam seti kırılımı (kampanya düzeyindeki satırlar kırılıma girmez). */
export async function campaignBreakdown(workspaceId: string, campaignId: string, since: Date) {
  const rows = await resolvedRows(workspaceId, since, [campaignId]);
  const daily = new Map<string, Metrics>();
  const byAdSet = new Map<string, Metrics>();
  for (const r of rows) {
    daily.set(r.date, add(daily.get(r.date) ?? EMPTY_METRICS, r.sums));
    if (r.adSetId) byAdSet.set(r.adSetId, add(byAdSet.get(r.adSetId) ?? EMPTY_METRICS, r.sums));
  }
  return {
    daily: [...daily.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, m]) => ({ date, ...m })),
    byAdSet,
    total: [...daily.values()].reduce((acc, m) => add(acc, m), EMPTY_METRICS),
  };
}

/** `days` gün öncesinin UTC gün başı (bugün dahil `days` gün). */
export function sinceDays(days: number, now = new Date()): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - (days - 1));
  return d;
}

/** Lead başı maliyet (minor); lead yoksa null. */
export const cpl = (m: Metrics) => (m.leads > 0 ? Math.round(m.spend / m.leads) : null);
export const roas = (m: Metrics) => (m.spend > 0 ? m.conversionValue / m.spend : null);

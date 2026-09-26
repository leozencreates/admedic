import { prisma } from "@admedic/database";
import { requireActor } from "../../_lib/auth";
import { respond } from "../../_lib/http";
export const maxDuration = 15;

/** Nitelikli lead: QUALIFIED ve sonrası (spec 3.10 "nitelikli lead oranı"). */
const QUALIFIED_STATUSES = ["QUALIFIED", "CONSULTATION_BOOKED", "TRAVEL_PLANNED", "TREATED"] as const;
const PERIOD_DAYS = 30;

function ratio(n: number, d: number): number | null {
  return d > 0 ? n / d : null;
}
function round4(v: number | null): number | null {
  return v === null ? null : Number(v.toFixed(4));
}

/**
 * Son 30 günün performans özeti (spec 3.10): harcama, gösterim, CPM, CTR, lead, CPL,
 * nitelikli lead oranı, kampanya kırılımı, pazar (ülke) / dil kırılımı. Para değerleri
 * minor unit (`…Cents`), oranlar 0-1; `currency` hesabın para birimidir (ADR-0011).
 */
export async function GET() {
  return respond(async () => {
    const actor = await requireActor();
    const now = new Date();
    const since = new Date(now);
    since.setUTCHours(0, 0, 0, 0);
    since.setUTCDate(since.getUTCDate() - PERIOD_DAYS);
    const workspaceId = actor.workspaceId;
    const leadWhere = { workspaceId, createdAt: { gte: since } };

    const [workspace, defaultAccount, snapshots, alerts, recommendations, campaigns, leadTotal, leadQualified, byCountryAll, byCountryQualified, byLanguageAll, byLanguageQualified] = await Promise.all([
      prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { currency: true } }),
      prisma.adAccount.findFirst({ where: { workspaceId }, orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }], select: { currency: true } }),
      prisma.insightSnapshot.findMany({
        where: { workspaceId, date: { gte: since }, granularity: "DAILY" },
        select: { date: true, campaignId: true, spend: true, impressions: true, clicks: true, purchases: true, conversionValue: true, linkClicks: true, leads: true, reach: true },
        orderBy: { date: "asc" },
      }),
      prisma.alert.findMany({
        where: { workspaceId, status: "OPEN", createdAt: { gte: since } },
        select: { id: true, type: true, severity: true, title: true, createdAt: true },
        orderBy: { createdAt: "desc" }, take: 10,
      }),
      prisma.recommendation.findMany({
        where: { workspaceId, status: "PENDING" },
        select: { id: true, type: true, action: true, title: true, description: true, reasoning: true, priority: true, createdAt: true },
        orderBy: { createdAt: "desc" }, take: 5,
      }),
      prisma.campaign.findMany({
        where: { workspaceId, status: "ACTIVE" },
        select: { id: true, name: true, dailyBudget: true, status: true, objective: true },
      }),
      prisma.lead.count({ where: leadWhere }),
      prisma.lead.count({ where: { ...leadWhere, status: { in: [...QUALIFIED_STATUSES] } } }),
      prisma.lead.groupBy({ by: ["country"], where: leadWhere, _count: { _all: true } }),
      prisma.lead.groupBy({ by: ["country"], where: { ...leadWhere, status: { in: [...QUALIFIED_STATUSES] } }, _count: { _all: true } }),
      prisma.lead.groupBy({ by: ["language"], where: leadWhere, _count: { _all: true } }),
      prisma.lead.groupBy({ by: ["language"], where: { ...leadWhere, status: { in: [...QUALIFIED_STATUSES] } }, _count: { _all: true } }),
    ]);
    const currency = defaultAccount?.currency ?? workspace.currency ?? "EUR";

    const totalSpend = snapshots.reduce((s, i) => s + i.spend, 0);
    const totalImpressions = snapshots.reduce((s, i) => s + i.impressions, 0);
    const totalClicks = snapshots.reduce((s, i) => s + i.clicks, 0);
    const totalPurchases = snapshots.reduce((s, i) => s + i.purchases, 0);
    const totalConvValue = snapshots.reduce((s, i) => s + i.conversionValue, 0);
    const totalReach = snapshots.reduce((s, i) => s + (i.reach ?? 0), 0);
    const totalMetaLeads = snapshots.reduce((s, i) => s + i.leads, 0);
    const ctr = ratio(totalClicks, totalImpressions);
    const cpmCents = totalImpressions > 0 ? Math.round((totalSpend / totalImpressions) * 1000) : null;
    const cpcCents = totalClicks > 0 ? Math.round(totalSpend / totalClicks) : null;
    const cpaCents = totalPurchases > 0 ? Math.round(totalSpend / totalPurchases) : null;
    const cplCents = leadTotal > 0 ? Math.round(totalSpend / leadTotal) : null;
    const roas = totalSpend > 0 ? Number((totalConvValue / totalSpend).toFixed(2)) : null;

    // Günlük seri: aynı güne ait kampanya satırları toplanır.
    const dailyMap = new Map<string, { date: string; spend: number; impressions: number; clicks: number; leads: number; purchases: number }>();
    for (const s of snapshots) {
      const key = s.date.toISOString().slice(0, 10);
      const d = dailyMap.get(key) ?? { date: key, spend: 0, impressions: 0, clicks: 0, leads: 0, purchases: 0 };
      d.spend += s.spend; d.impressions += s.impressions; d.clicks += s.clicks; d.leads += s.leads; d.purchases += s.purchases;
      dailyMap.set(key, d);
    }
    const daily = [...dailyMap.values()].map((d) => ({
      ...d,
      ctr: round4(ratio(d.clicks, d.impressions)),
      cpcCents: d.clicks > 0 ? Math.round(d.spend / d.clicks) : null,
      cpmCents: d.impressions > 0 ? Math.round((d.spend / d.impressions) * 1000) : null,
    }));

    // Kampanya kırılımı: harcama/bütçe oranı cent/cent, veri günü sayısına göre.
    const perCampaign = new Map<string, { spend: number; impressions: number; clicks: number; leads: number; purchases: number; days: Set<string> }>();
    for (const s of snapshots) {
      if (!s.campaignId) continue;
      const c = perCampaign.get(s.campaignId) ?? { spend: 0, impressions: 0, clicks: 0, leads: 0, purchases: 0, days: new Set<string>() };
      c.spend += s.spend; c.impressions += s.impressions; c.clicks += s.clicks; c.leads += s.leads; c.purchases += s.purchases;
      c.days.add(s.date.toISOString().slice(0, 10));
      perCampaign.set(s.campaignId, c);
    }
    const campaignBreakdown = campaigns.map((c) => {
      const sum = perCampaign.get(c.id);
      const spentCents = sum?.spend ?? 0;
      const days = sum?.days.size ?? 0;
      const budgetCents = c.dailyBudget ?? null;
      const periodBudgetCents = budgetCents !== null && days > 0 ? budgetCents * days : null;
      const leadCount = sum?.leads ?? 0;
      return {
        id: c.id,
        name: c.name,
        objective: c.objective,
        budgetCents,
        spentCents,
        days,
        spendPercent: periodBudgetCents ? Math.round((spentCents / periodBudgetCents) * 100) : 0,
        impressions: sum?.impressions ?? 0,
        clicks: sum?.clicks ?? 0,
        ctr: round4(ratio(sum?.clicks ?? 0, sum?.impressions ?? 0)),
        cpmCents: sum && sum.impressions > 0 ? Math.round((sum.spend / sum.impressions) * 1000) : null,
        leadCount,
        cplCents: leadCount > 0 ? Math.round(spentCents / leadCount) : null,
      };
    });

    const qualifiedByCountry = new Map(byCountryQualified.map((g) => [g.country ?? null, g._count._all]));
    const byCountry = byCountryAll
      .map((g) => ({ country: g.country ?? null, leads: g._count._all, qualified: qualifiedByCountry.get(g.country ?? null) ?? 0 }))
      .sort((x, y) => y.leads - x.leads || y.qualified - x.qualified || (x.country ?? "~").localeCompare(y.country ?? "~"));
    const qualifiedByLanguage = new Map(byLanguageQualified.map((g) => [g.language, g._count._all]));
    const byLanguage = byLanguageAll
      .map((g) => ({ language: g.language, leads: g._count._all, qualified: qualifiedByLanguage.get(g.language) ?? 0 }))
      .sort((x, y) => y.leads - x.leads || y.qualified - x.qualified || x.language.localeCompare(y.language));

    const summary = {
      totalSpend,
      totalImpressions,
      totalClicks,
      totalPurchases,
      totalConvValue,
      totalReach,
      totalMetaLeads,
      ctr: round4(ctr) ?? 0,
      cpmCents,
      cpcCents,
      cpaCents,
      cplCents,
      roas,
      reachRate: round4(ratio(totalReach, totalImpressions)) ?? 0,
      qualifiedLeadRatio: round4(ratio(leadQualified, leadTotal)) ?? 0,
      qualifiedLeads: leadQualified,
      totalLeads: leadTotal,
    };
    return {
      currency,
      insights: {
        period: { from: since.toISOString(), to: now.toISOString(), days: PERIOD_DAYS },
        summary,
        daily,
        campaigns: campaignBreakdown,
        byCountry,
        byLanguage,
      },
      alerts: alerts.map((a) => ({ id: a.id, type: a.type, severity: a.severity, title: a.title, createdAt: a.createdAt })),
      pendingRecommendations: recommendations.map((r) => ({
        id: r.id,
        type: typeof (r.action as { type?: unknown } | null)?.type === "string" ? String((r.action as { type: string }).type) : r.type,
        title: r.title, description: r.description, reasoning: r.reasoning, priority: r.priority, createdAt: r.createdAt,
      })),
    };
  });
}

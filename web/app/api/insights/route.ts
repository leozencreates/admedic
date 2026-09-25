import { prisma } from "@admedic/database";
import { requireActor } from "../../_lib/auth";
import { respond, sameOrigin } from "../../_lib/http";
export const maxDuration = 15;
export async function GET() {
  return respond(async () => {
    const actor = await requireActor();
    const now = new Date();
    const last7d = new Date(now);
    last7d.setDate(last7d.getDate() - 7);
    const [snapshots, alerts, recommendations, campaigns, campaignSums, leads, qualifiedLeads] = await Promise.all([
      prisma.insightSnapshot.findMany({
        where: { workspaceId: actor.workspaceId, date: { gte: last7d } },
        select: { date: true, spend: true, impressions: true, clicks: true, purchases: true, conversionValue: true, ctr: true, cpc: true, frequency: true, linkClicks: true, addsToCart: true, initiatesCheckout: true, leads: true, reach: true },
        orderBy: { date: "asc" }, take: 30,
      }),
      prisma.alert.findMany({
        where: { workspaceId: actor.workspaceId, createdAt: { gte: new Date(now.setDate(now.getDate() - 7)) }, read: false },
        select: { id: true, type: true, severity: true, title: true, createdAt: true },
        orderBy: { createdAt: "desc" }, take: 10,
      }),
      prisma.recommendation.findMany({
        where: { workspaceId: actor.workspaceId, status: "PENDING" },
        select: { id: true, type: true, title: true, description: true, reasoning: true, createdAt: true },
        orderBy: { createdAt: "desc" }, take: 5,
      }),
      prisma.campaign.findMany({
        where: { workspaceId: actor.workspaceId, status: "ACTIVE" },
        select: { id: true, name: true, dailyBudget: true, status: true, objective: true },
      }),
      prisma.insightSnapshot.groupBy({
        by: ["campaignId"],
        where: { workspaceId: actor.workspaceId, date: { gte: last7d }, campaignId: { not: null } },
        _sum: { spend: true, impressions: true, clicks: true, purchases: true, conversionValue: true, leads: true },
      }) as unknown as Array<{ campaignId: string | null; _sum: { spend: number | null; impressions: number | null; clicks: number | null; purchases: number | null; conversionValue: number | null; leads: number | null } }>,
      prisma.lead.aggregate({
        where: { workspaceId: actor.workspaceId, createdAt: { gte: last7d } },
        _count: { id: true },
      }),
      prisma.lead.aggregate({
        where: { workspaceId: actor.workspaceId, createdAt: { gte: last7d }, status: "QUALIFIED" },
        _count: { id: true },
      }),
    ]);
    const totalSpend = snapshots.reduce((s, i) => s + i.spend, 0);
    const totalImpressions = snapshots.reduce((s, i) => s + i.impressions, 0);
    const totalClicks = snapshots.reduce((s, i) => s + i.clicks, 0);
    const totalPurchases = snapshots.reduce((s, i) => s + i.purchases, 0);
    const totalConvValue = snapshots.reduce((s, i) => s + i.conversionValue, 0);
    const totalReach = snapshots.reduce((s, i) => s + (i.reach ?? 0), 0);
    const ctr = totalImpressions > 0 ? totalClicks / totalImpressions : 0;
    const cpc = totalClicks > 0 ? totalSpend / totalClicks : null;
    const cpa = totalPurchases > 0 ? totalSpend / totalPurchases : null;
    const reachRate = totalImpressions > 0 ? totalReach / totalImpressions : 0;
    const qualifiedCount = qualifiedLeads._count.id;
    const totalLeadCount = leads._count.id;
    const qualifiedRatio = totalLeadCount > 0 ? qualifiedCount / totalLeadCount : 0;
    const cpl = totalLeadCount > 0 ? totalSpend / totalLeadCount : null;
    const daily = snapshots.map((s) => ({ date: s.date.toISOString().slice(0, 10), spend: s.spend, clicks: s.clicks, purchases: s.purchases, impressions: s.impressions, ctr: s.ctr, cpc: s.cpc }));
    const byCampaign = new Map(campaignSums.map((g) => [g.campaignId, g._sum]));
    const campaignBreakdown = campaigns.map((c) => {
      const sum = byCampaign.get(c.id);
      const spent = sum?.spend ?? 0;
      const leadCount = sum?.leads ?? 0;
      const cplVal = leadCount > 0 ? spent / leadCount : null;
      return { id: c.id, name: c.name, objective: c.objective, budget: c.dailyBudget ?? 0, spent, spendPercent: c.dailyBudget ? Math.round((spent / c.dailyBudget) * 100) : 0, leadCount, cpl: cplVal };
    });
    const summary = {
      totalSpend,
      totalImpressions,
      totalClicks,
      totalPurchases,
      totalConvValue,
      ctr: Number(ctr.toFixed(4)),
      cpc: cpc !== null ? Number((cpc / 100).toFixed(2)) : null,
      cpa: cpa !== null ? Number((cpa / 100).toFixed(2)) : null,
      cpl: cpl !== null ? Number((cpl / 100).toFixed(2)) : null,
      reachRate: Number(reachRate.toFixed(4)),
      qualifiedLeadRatio: Number(qualifiedRatio.toFixed(4)),
      qualifiedLeads: qualifiedCount,
      totalLeads: totalLeadCount,
    };
    return {
      insights: {
        period: { from: last7d.toISOString(), to: now.toISOString() },
        summary,
        daily,
        campaigns: campaignBreakdown,
      },
      alerts: alerts.map((a) => ({ id: a.id, type: a.type, severity: a.severity, title: a.title, createdAt: a.createdAt })),
      pendingRecommendations: recommendations.map((r) => ({ id: r.id, type: r.type, title: r.title, description: r.description, reasoning: r.reasoning, createdAt: r.createdAt })),
    };
  });
}
import { HttpError } from "../../_lib/http";
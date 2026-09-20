import { type FastifyInstance } from "fastify";
import { z } from "zod";

import { prisma, getPrimaryWorkspace, daysAgoUTC, roas } from "./lib";

/** ADR-0001: read-only REST. Tüm iş mantığı `@admedic/database` + `@admedic/shared`'de; API yalnızca taşır. */

const daysQuery = z.object({
  days: z.coerce.number().int().min(1).max(90).default(7),
});

function parseDays(query: unknown): number {
  const parsed = daysQuery.safeParse(query);
  return parsed.success ? parsed.data.days : 7;
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async () => ({
    name: "admedic-api",
    endpoints: ["/health", "/v1/overview", "/v1/campaigns", "/v1/decisions", "/v1/alerts"],
  }));

  app.get("/health", async () => ({ ok: true, service: "admedic-api" }));

  app.get("/v1/overview", async (req) => {
    const days = parseDays(req.query);
    const ws = await getPrimaryWorkspace();
    if (!ws) return { workspace: null, days, counts: null };

    const since = daysAgoUTC(days - 1);
    const [counts, agg, budget, pending, openAlerts, policy] = await Promise.all([
      Promise.all([
        prisma.campaign.count({ where: { workspaceId: ws.id } }),
        prisma.adSet.count({ where: { workspaceId: ws.id } }),
        prisma.ad.count({ where: { workspaceId: ws.id } }),
      ]),
      prisma.insightSnapshot.aggregate({
        where: { workspaceId: ws.id, date: { gte: since } },
        _sum: { spend: true, conversionValue: true, purchases: true, clicks: true },
      }),
      prisma.adSet.aggregate({
        where: { workspaceId: ws.id, status: "ACTIVE" },
        _sum: { dailyBudget: true },
      }),
      prisma.agentDecision.count({ where: { workspaceId: ws.id, approval: "PENDING" } }),
      prisma.alert.count({ where: { workspaceId: ws.id, status: "OPEN" } }),
      prisma.optimizationPolicy.findUnique({ where: { workspaceId: ws.id } }),
    ]);

    const spend = agg._sum.spend ?? 0;
    const revenue = agg._sum.conversionValue ?? 0;

    return {
      workspace: { id: ws.id, slug: ws.slug, name: ws.name, currency: ws.currency },
      days,
      counts: { campaigns: counts[0], adsets: counts[1], ads: counts[2] },
      lastNDays: {
        spendCents: spend,
        revenueCents: revenue,
        purchases: agg._sum.purchases ?? 0,
        clicks: agg._sum.clicks ?? 0,
        roas: roas(revenue, spend),
      },
      budget: { activeAdSetDailyTotalCents: budget._sum.dailyBudget ?? 0 },
      approvals: { pending },
      alerts: { open: openAlerts },
      policy: policy
        ? { mode: policy.mode, enabled: policy.enabled, targetRoas: policy.targetRoas }
        : null,
    };
  });

  app.get("/v1/campaigns", async (req) => {
    const days = parseDays(req.query);
    const ws = await getPrimaryWorkspace();
    if (!ws) return { workspace: null, days, campaigns: [] };

    const since = daysAgoUTC(days - 1);
    const [campaigns, grouped] = await Promise.all([
      prisma.campaign.findMany({
        where: { workspaceId: ws.id },
        include: { adAccount: { select: { name: true, currency: true } }, _count: { select: { adsets: true } } },
        orderBy: { name: "asc" },
      }),
      prisma.insightSnapshot.groupBy({
        by: ["campaignId"],
        where: { workspaceId: ws.id, date: { gte: since }, campaignId: { not: null } },
        _sum: { spend: true, conversionValue: true, purchases: true, clicks: true },
      }),
    ]);

    const byCampaign = new Map(grouped.map((g) => [g.campaignId, g._sum]));
    return {
      workspace: { id: ws.id },
      days,
      campaigns: campaigns.map((c) => {
        const sum = byCampaign.get(c.id);
        const spend = sum?.spend ?? 0;
        const revenue = sum?.conversionValue ?? 0;
        return {
          id: c.id,
          name: c.name,
          status: c.status,
          dailyBudgetCents: c.dailyBudget ?? 0,
          adAccount: c.adAccount,
          adSetCount: c._count.adsets,
          lastNDays: {
            spendCents: spend,
            revenueCents: revenue,
            purchases: sum?.purchases ?? 0,
            clicks: sum?.clicks ?? 0,
            roas: roas(revenue, spend),
          },
        };
      }),
    };
  });

  app.get("/v1/decisions", async () => {
    const ws = await getPrimaryWorkspace();
    if (!ws) return { workspace: null, decisions: [], summary: {} };

    const [decisions, grouped, budgetChanges] = await Promise.all([
      prisma.agentDecision.findMany({
        where: { workspaceId: ws.id },
        orderBy: { createdAt: "desc" },
        take: 40,
      }),
      prisma.agentDecision.groupBy({
        by: ["approval"],
        where: { workspaceId: ws.id },
        _count: { _all: true },
      }),
      prisma.budgetChange.findMany({
        where: { workspaceId: ws.id },
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
    ]);

    const adIds = decisions.filter((d) => d.targetType === "AD").map((d) => d.targetId);
    const ads = await prisma.ad.findMany({
      where: { id: { in: adIds } },
      select: { id: true, name: true },
    });
    const adNames = new Map(ads.map((a) => [a.id, a.name]));

    return {
      workspace: { id: ws.id },
      summary: Object.fromEntries(grouped.map((g) => [g.approval, g._count._all])),
      decisions: decisions.map((d) => ({
        id: d.id,
        targetType: d.targetType,
        targetId: d.targetId,
        targetName: adNames.get(d.targetId) ?? null,
        action: d.action,
        approval: d.approval,
        reason: d.reason,
        algorithm: d.algorithm,
        createdAt: d.createdAt,
      })),
      budgetChanges,
    };
  });

  app.get("/v1/alerts", async () => {
    const ws = await getPrimaryWorkspace();
    if (!ws) return { workspace: null, summary: {}, alerts: [] };

    const [alerts, open, critical, warning] = await Promise.all([
      prisma.alert.findMany({
        where: { workspaceId: ws.id },
        orderBy: { createdAt: "desc" },
        take: 40,
      }),
      prisma.alert.count({ where: { workspaceId: ws.id, status: "OPEN" } }),
      prisma.alert.count({ where: { workspaceId: ws.id, status: "OPEN", severity: "CRITICAL" } }),
      prisma.alert.count({ where: { workspaceId: ws.id, status: "OPEN", severity: "WARNING" } }),
    ]);

    return {
      workspace: { id: ws.id },
      summary: { open, critical, warning },
      alerts,
    };
  });
}

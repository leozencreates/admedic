import { type FastifyInstance } from "fastify";
import { loadEnv } from "@admedic/config";

import { prisma, getPrimaryWorkspace, daysAgoUTC, roas, parseDays, campaignSummaries, serviceName } from "./lib";

/** ADR-0001: read-only REST. Tüm iş mantığı `@admedic/database` + `@admedic/shared`'de; API yalnızca taşır. */

const ENDPOINTS = ["/health", "/v1/overview", "/v1/campaigns", "/v1/decisions", "/v1/alerts"];

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async () => {
    const env = loadEnv();
    return { name: serviceName(env), appName: env.APP_NAME, endpoints: ENDPOINTS };
  });

  app.get("/health", async () => ({ ok: true, service: serviceName() }));

  app.get("/v1/overview", async (req) => {
    const days = parseDays(req.query);
    const env = loadEnv();
    const ws = await getPrimaryWorkspace();
    if (!ws) return { appName: env.APP_NAME, workspace: null, days, counts: null, campaigns: [] };

    const since = daysAgoUTC(days - 1);
    const [counts, agg, budget, pending, openAlerts, policy, campaigns] = await Promise.all([
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
      campaignSummaries(ws.id, days),
    ]);

    const spend = agg._sum.spend ?? 0;
    const revenue = agg._sum.conversionValue ?? 0;

    return {
      appName: env.APP_NAME,
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
      // Masaüstü kabuğunun beklediği liste (dailyBudgetCents minor unit, ADR-0011).
      campaigns,
    };
  });

  app.get("/v1/campaigns", async (req) => {
    const days = parseDays(req.query);
    const ws = await getPrimaryWorkspace();
    if (!ws) return { workspace: null, days, campaigns: [] };
    return { workspace: { id: ws.id }, days, campaigns: await campaignSummaries(ws.id, days) };
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

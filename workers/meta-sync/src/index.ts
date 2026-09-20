import { prisma } from "@admedic/database";
import { loadEnv } from "@admedic/config";
import { createMetaClient, type MetaClientLike } from "@admedic/meta-api";
import { MetaInsightRow } from "@admedic/meta-api";

export interface SyncResult {
  experimentId: string;
  variantMetrics: Array<{
    variantId: string;
    pointsCreated: number;
    totalSpend: number;
    totalClicks: number;
    totalLeads: number;
  }>;
  elapsedDays: number;
  status: "RUNNING" | "COMPLETED";
  completed: boolean;
}

export interface SyncJob {
  run: () => Promise<SyncResult[]>;
}

export function createMetaSyncWorker(client?: MetaClientLike): SyncJob {
  const meta = client ?? createMetaClient();
  return {
    async run() {
      loadEnv();
      const experiments = await prisma.studioExperiment.findMany({
        where: { status: "RUNNING" },
        include: { draft: { include: { workspace: true } } },
      });
      const results: SyncResult[] = [];
      for (const experiment of experiments) {
        const result = await syncExperiment(meta, experiment);
        results.push(result);
      }
      return results;
    },
  };
}

async function syncExperiment(meta: MetaClientLike, experiment: any): Promise<SyncResult> {
  const draft = experiment.draft;
  const workspace = draft.workspace;
  const adAccount = workspace.adAccounts?.find((a: any) => a.isDefault) ?? workspace.adAccounts?.[0];
  if (!adAccount) throw new Error(`No ad account for workspace ${workspace.id}`);
  const token = workspace.metaConnections?.[0]?.metaAccountId ?? "";

  const snapshot = JSON.parse(experiment.snapshot as string) as { variants: any[] };
  const variants = snapshot.variants ?? [];
  const variantMetrics: SyncResult["variantMetrics"] = [];

  for (let i = 0; i < variants.length; i++) {
    const adSets = await meta.listAdSets(adAccount.id, token).catch(() => []);
    let totalSpend = 0, totalClicks = 0, totalLeads = 0, totalPoints = 0;

    for (const adSet of adSets) {
      let rows: MetaInsightRow[] = [];
      try {
        rows = await meta.getInsights({ type: "adset", id: adSet.id }, "", { datePreset: "last_7d", level: "adset" });
      } catch { continue; }
      for (const row of rows) {
        const spendMajor = row.spendMajor ?? 0;
        totalSpend += spendMajor;
        totalClicks += row.clicks;
        totalLeads += row.purchases ?? 0;
        totalPoints++;
        await prisma.experimentMetricPoint.create({
          data: {
            experimentId: experiment.id,
            variantId: experiment.variants[i].id,
            spend: spendMajor,
            revenue: row.purchaseValueMajor ?? 0,
            purchases: row.purchases ?? 0,
            impressions: row.impressions,
            clicks: row.clicks,
            addsToCart: 0,
            initiatesCheckout: 0,
            ctr: row.ctr,
          },
        });
      }
    }
    variantMetrics.push({
      variantId: experiment.variants[i].id,
      pointsCreated: totalPoints,
      totalSpend,
      totalClicks,
      totalLeads,
    });
  }

  const variantTotals = await Promise.all(
    experiment.variants.map(async (v: any) => {
      const agg = await prisma.experimentMetricPoint.aggregate({
        where: { experimentId: experiment.id, variantId: v.id },
        _sum: { spend: true, clicks: true },
        _count: { _all: true },
      });
      return { spend: agg._sum.spend ?? 0, clicks: agg._count._all ?? 0, leads: 0 };
    }),
  );
  const totalClicks = variantTotals.reduce((s, v) => s + v.clicks, 0);
  const totalLeads = variantTotals.reduce((s, v) => s + v.leads, 0);
  const elapsedDays = experiment.elapsedDays + 1;
  const completed = elapsedDays >= (JSON.parse(experiment.snapshot as string) as { duration: number }).duration;

  await prisma.studioExperiment.updateMany({
    where: { id: experiment.id },
    data: {
      metrics: JSON.stringify(variantTotals),
      elapsedDays,
      status: completed ? "COMPLETED" : "RUNNING",
      version: { increment: 1 },
    },
  });

  return {
    experimentId: experiment.id,
    variantMetrics,
    elapsedDays,
    status: completed ? "COMPLETED" : "RUNNING",
    completed,
  };
}

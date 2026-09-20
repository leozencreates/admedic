import { prisma } from "@/lib/prisma";
import {
  DEFAULT_ENGINE_CONFIG,
  runAgentCycle,
  type EngineVariantInput,
  type EngineConfig,
} from "./engine";
import { updateAdSetDailyBudget } from "@/lib/meta/client";
import type { VariantStatInput } from "./statistics";

export interface RunCycleOptions {
  pushToMeta?: boolean;
}

// Bir test için günlük metrik noktalarını varyant bazında toplar.
async function loadEngineVariants(
  testRunId: string
): Promise<EngineVariantInput[]> {
  const testRun = await prisma.testRun.findUnique({
    where: { id: testRunId },
    include: {
      variants: { include: { metrics: { orderBy: { date: "asc" } } } },
    },
  });
  if (!testRun) throw new Error("Test bulunamadı");

  return testRun.variants.map((v) => {
    const points: VariantStatInput[] = v.metrics.map((m) => ({
      date: m.date.toISOString().slice(0, 10),
      impressions: m.impressions,
      clicks: m.clicks,
      spendKurus: m.spendKurus,
      conversions: m.conversions,
      revenueKurus: m.revenueKurus,
    }));
    return {
      variantId: v.id,
      metaAdSetId: v.metaAdSetId,
      name: v.name,
      currentBudgetKurus: v.budgetKurus,
      initialBudgetKurus: v.initialBudgetKurus,
      active: v.active,
      points,
    };
  });
}

export async function runAgentCycleForTest(
  testRunId: string,
  config: Partial<EngineConfig> = {},
  options: RunCycleOptions = {}
) {
  const testRun = await prisma.testRun.findUnique({
    where: { id: testRunId },
    include: {
      campaign: {
        include: { metaAccount: true },
      },
    },
  });
  if (!testRun) throw new Error("Test bulunamadı");

  if (testRun.status !== "RUNNING") {
    return {
      skipped: true,
      reason: `Test durumu "${testRun.status}", agent yalnızca çalışan testlerde adım atar.`,
    };
  }

  const engineVariants = await loadEngineVariants(testRunId);
  const engineConfig = { ...DEFAULT_ENGINE_CONFIG, ...config };
  const decision = runAgentCycle(engineVariants, engineConfig);

  let metaPushError: string | null = null;
  let severity = decision.severity;

  if (
    options.pushToMeta &&
    (decision.action === "BUDGET_SHIFT" || decision.action === "WINNER_SELECTED") &&
    testRun.campaign.metaAccount.accessToken
  ) {
    try {
      await applyBudgetsToMeta(testRun, decision.budgetUpdates);
      decision.detail += " Bütçe Meta'ya iletildi.";
    } catch (e) {
      metaPushError = e instanceof Error ? e.message : String(e);
      severity = "WARNING";
    }
  }

  const action = await prisma.agentAction.create({
    data: {
      testRunId,
      type: decision.action,
      detail: decision.detail + (metaPushError ? ` [Meta: ${metaPushError}]` : ""),
      severity,
    },
  });

  let winningVariantId: string | null = testRun.winningVariantId;
  let status = testRun.status;

  if ("budgetUpdates" in decision) {
    for (const u of decision.budgetUpdates) {
      await prisma.variant.update({
        where: { id: u.variantId },
        data: { budgetKurus: u.newBudgetKurus },
      });
    }
  }

  if (decision.action === "WINNER_SELECTED" && decision.winningVariantId) {
    winningVariantId = decision.winningVariantId;
    status = "WINNER_SELECTED";
    await prisma.testRun.update({
      where: { id: testRunId },
      data: {
        winningVariantId,
        status,
        endedAt: new Date(),
      },
    });
  }

  return {
    skipped: false,
    decision,
    action,
    winningVariantId,
    status,
    metaPushError,
  };
}

async function applyBudgetsToMeta(
  testRun: {
    campaign: {
      metaCampaignId: string;
      currency: string;
      metaAccount: { adAccountId: string; accessToken: string | null };
    };
  },
  updates: { variantId: string; newBudgetKurus: number }[]
) {
  const variants = await prisma.variant.findMany({
    where: { id: { in: updates.map((u) => u.variantId) } },
  });
  const metaUpdates = [];
  for (const u of updates) {
    const v = variants.find((x) => x.id === u.variantId);
    if (v?.metaAdSetId) {
      metaUpdates.push({
        adSetId: v.metaAdSetId,
        dailyBudget: u.newBudgetKurus / 100,
      });
    }
  }
  if (metaUpdates.length > 0) {
    await updateAdSetDailyBudget(
      testRun.campaign.metaAccount.accessToken!,
      testRun.campaign.metaAccount.adAccountId,
      metaUpdates,
      testRun.campaign.metaCampaignId,
      testRun.campaign.currency
    );
  }
}
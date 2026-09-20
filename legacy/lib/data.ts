import { prisma } from "@/lib/prisma";
import { getCurrentClinic } from "@/lib/clinic";

export async function getDashboard() {
  const clinic = await getCurrentClinic();
  const tests = await prisma.testRun.findMany({
    where: { campaign: { metaAccount: { clinicId: clinic.id } } },
    include: {
      campaign: true,
      variants: { include: { metrics: true } },
    },
    orderBy: { startedAt: "desc" },
  });

  let totalSpend = 0;
  let totalRevenue = 0;
  let totalConversions = 0;
  for (const t of tests) {
    for (const v of t.variants) {
      totalSpend += v.metrics.reduce((a, m) => a + m.spendKurus, 0);
      totalRevenue += v.metrics.reduce((a, m) => a + m.revenueKurus, 0);
      totalConversions += v.metrics.reduce((a, m) => a + m.conversions, 0);
    }
  }

  return {
    clinic,
    totalSpendKurus: totalSpend,
    totalRevenueKurus: totalRevenue,
    totalConversions,
    roas: totalSpend > 0 ? totalRevenue / totalSpend : 0,
    runningCount: tests.filter((t) => t.status === "RUNNING").length,
    finishedCount: tests.filter((t) => t.status === "WINNER_SELECTED").length,
    tests: tests.map((t) => ({
      id: t.id,
      name: t.name,
      status: t.status,
      startedAt: t.startedAt,
      endedAt: t.endedAt,
      campaignName: t.campaign.name,
      winningVariantId: t.winningVariantId,
      winnerName:
        t.variants.find((v) => v.id === t.winningVariantId)?.name ?? null,
      variantCount: t.variants.length,
    })),
  };
}

export async function getCampaigns() {
  const clinic = await getCurrentClinic();
  const campaigns = await prisma.campaign.findMany({
    where: { metaAccount: { clinicId: clinic.id } },
    include: { metaAccount: true, tests: true },
    orderBy: { createdAt: "desc" },
  });
  return {
    metaConnected: campaigns.some(
      (c) => !!c.metaAccount.accessToken && c.metaAccount.active
    ),
    campaigns: campaigns.map((c) => ({
      id: c.id,
      name: c.name,
      metaCampaignId: c.metaCampaignId,
      status: c.status,
      dailyBudgetKurus: c.dailyBudgetKurus,
      currency: c.currency,
      runningTestCount: c.tests.filter((t) => t.status === "RUNNING").length,
    })),
  };
}

export async function getTests() {
  const clinic = await getCurrentClinic();
  const tests = await prisma.testRun.findMany({
    where: { campaign: { metaAccount: { clinicId: clinic.id } } },
    include: {
      campaign: true,
      variants: { include: { metrics: true } },
      actions: true,
    },
    orderBy: { startedAt: "desc" },
  });

  return tests.map((t) => {
    const totalSpend = t.variants.reduce(
      (a, v) => a + v.metrics.reduce((x, m) => x + m.spendKurus, 0),
      0
    );
    const totalRevenue = t.variants.reduce(
      (a, v) => a + v.metrics.reduce((x, m) => x + m.revenueKurus, 0),
      0
    );
    return {
      id: t.id,
      name: t.name,
      status: t.status,
      startedAt: t.startedAt,
      endedAt: t.endedAt,
      campaignName: t.campaign.name,
      variantCount: t.variants.length,
      totalSpendKurus: totalSpend,
      totalRevenueKurus: totalRevenue,
      roas: totalSpend > 0 ? totalRevenue / totalSpend : 0,
      winningVariantId: t.winningVariantId,
      winnerName:
        t.variants.find((v) => v.id === t.winningVariantId)?.name ?? null,
      lastAction: t.actions.sort(
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
      )[0],
    };
  });
}

export async function getTestDetail(id: string) {
  const test = await prisma.testRun.findUnique({
    where: { id },
    include: {
      campaign: { include: { metaAccount: true } },
      variants: {
        include: { metrics: { orderBy: { date: "asc" } } },
      },
      actions: { orderBy: { createdAt: "desc" } },
    },
  });
  return test;
}
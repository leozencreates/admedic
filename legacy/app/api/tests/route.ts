import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentClinic } from "@/lib/clinic";

// GET /api/tests → tüm testler + istatistik özetleri
export async function GET() {
  const clinic = await getCurrentClinic();
  const tests = await prisma.testRun.findMany({
    where: { campaign: { metaAccount: { clinicId: clinic.id } } },
    include: {
      campaign: {
        include: { metaAccount: true },
      },
      variants: {
        include: { metrics: true },
      },
      actions: { orderBy: { createdAt: "desc" }, take: 5 },
    },
    orderBy: { startedAt: "desc" },
  });

  const summary = tests.map((t) => {
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
    };
  });

  return NextResponse.json({ tests: summary });
}

// POST /api/tests → yeni A/B testi oluşturur
export async function POST(request: NextRequest) {
  const body = (await request.json()) as {
    campaignId: string;
    name: string;
    adSets?: { metaAdSetId: string; name: string }[];
    minSpendKurusPerVariant?: number;
    significanceLevel?: number;
  };

  if (!body.campaignId || !body.name) {
    return NextResponse.json(
      { error: "campaignId ve name zorunludur." },
      { status: 400 }
    );
  }

  const campaign = await prisma.campaign.findUnique({
    where: { id: body.campaignId },
  });
  if (!campaign) {
    return NextResponse.json(
      { error: "Kampanya bulunamadı." },
      { status: 404 }
    );
  }

  const adSets = body.adSets?.length ? body.adSets : null;

  const test = await prisma.testRun.create({
    data: {
      campaignId: campaign.id,
      name: body.name,
      minSamplePerVariant: 50,
      significanceLevel: body.significanceLevel ?? 0.95,
      variants: {
        create: adSets
          ? adSets.map((a) => {
              const budget = Math.floor(campaign.dailyBudgetKurus / adSets.length);
              return {
                name: a.name,
                metaAdSetId: a.metaAdSetId,
                budgetKurus: budget,
                initialBudgetKurus: budget,
              };
            })
          : [0, 1].map((i) => {
              const budget = Math.floor(campaign.dailyBudgetKurus / 2);
              return {
                name: `Varyant ${String.fromCharCode(65 + i)}`,
                budgetKurus: budget,
                initialBudgetKurus: budget,
              };
            }),
      },
    },
    include: { variants: true },
  });

  await prisma.agentAction.create({
    data: {
      testRunId: test.id,
      type: "TEST_START",
      detail: `Test başlatıldı: ${test.variants.length} varyant eşit bütçeyle yayına girdi.`,
      severity: "INFO",
    },
  });

  return NextResponse.json({ test }, { status: 201 });
}
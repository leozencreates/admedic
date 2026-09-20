import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

type Ctx = { params: Promise<{ id: string }> };

// GET /api/tests/[id]/metrics → grafik için varyant bazında günlük metrik serisi
export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const test = await prisma.testRun.findUnique({
    where: { id },
    include: {
      variants: { include: { metrics: { orderBy: { date: "asc" } } } },
    },
  });
  if (!test) {
    return NextResponse.json({ error: "Test bulunamadı." }, { status: 404 });
  }

  const variants = test.variants.map((v) => ({
    id: v.id,
    name: v.name,
    metaAdSetId: v.metaAdSetId,
    budgetKurus: v.budgetKurus,
    initialBudgetKurus: v.initialBudgetKurus,
    active: v.active,
    metrics: v.metrics.map((m) => ({
      date: m.date,
      spendKurus: m.spendKurus,
      revenueKurus: m.revenueKurus,
      roas: m.roas,
      conversions: m.conversions,
      impressions: m.impressions,
      clicks: m.clicks,
    })),
  }));

  return NextResponse.json({ variants });
}
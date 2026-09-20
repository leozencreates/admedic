import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentClinic } from "@/lib/clinic";

// GET /api/dashboard → genel özet
export async function GET() {
  const clinic = await getCurrentClinic();
  const tests = await prisma.testRun.findMany({
    where: { campaign: { metaAccount: { clinicId: clinic.id } } },
    include: { variants: { include: { metrics: true } } },
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

  const running = tests.filter((t) => t.status === "RUNNING").length;
  const finished = tests.filter((t) => t.status === "WINNER_SELECTED").length;

  return NextResponse.json({
    totalSpendKurus: totalSpend,
    totalRevenueKurus: totalRevenue,
    totalConversions,
    roas: totalSpend > 0 ? totalRevenue / totalSpend : 0,
    runningTestCount: running,
    finishedTestCount: finished,
    testCount: tests.length,
    clinic: { id: clinic.id, name: clinic.name, email: clinic.email },
  });
}
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentClinic } from "@/lib/clinic";

// GET /api/campaigns → kampanyalar + mevcut A/B testleri ve ad set bağlantıları
export async function GET() {
  const clinic = await getCurrentClinic();
  const campaigns = await prisma.campaign.findMany({
    where: { metaAccount: { clinicId: clinic.id } },
    include: {
      metaAccount: true,
      tests: { include: { variants: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  const metaConnected = campaigns.some(
    (c) => !!c.metaAccount.accessToken && c.metaAccount.active
  );

  return NextResponse.json({
    metaConnected,
    campaigns: campaigns.map((c) => ({
      id: c.id,
      name: c.name,
      metaCampaignId: c.metaCampaignId,
      status: c.status,
      dailyBudgetKurus: c.dailyBudgetKurus,
      currency: c.currency,
      runningTestCount: c.tests.filter((t) => t.status === "RUNNING").length,
      usedAdSetIds: c.tests
        .flatMap((t) => t.variants.map((v) => v.metaAdSetId).filter(Boolean)),
    })),
  });
}
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentClinic } from "@/lib/clinic";
import { fetchCampaigns, fetchAdSetDailyInsights } from "@/lib/meta/client";

// POST /api/meta/sync → Meta'dan kampanyaları ve ad set metriklerini çeker, DB'yi günceller
export async function POST() {
  try {
    const clinic = await getCurrentClinic();
    const account = await prisma.metaAccount.findFirst({
      where: { clinicId: clinic.id, active: true },
      orderBy: { createdAt: "desc" },
    });

    if (!account?.accessToken) {
      return NextResponse.json({
        demo: true,
        syncedCampaigns: 0,
        syncedMetricPoints: 0,
        message: "Meta hesabı bağlı değil (demo modu). Bağlamak için Meta Bağlantısı sayfasını kullan.",
      });
    }

    // 1) Kampanyaları çek ve upsert et
    const campaigns = await fetchCampaigns(account.accessToken, account.adAccountId);
    let syncedCampaigns = 0;
    for (const c of campaigns) {
      const existing = await prisma.campaign.findUnique({
        where: { metaCampaignId: c.id },
      });
      if (!existing) {
        await prisma.campaign.create({
          data: {
            metaAccountId: account.id,
            metaCampaignId: c.id,
            name: c.name,
            status: c.status,
            dailyBudgetKurus: (c.dailyBudget ?? 0) * 100,
            currency: c.currency,
          },
        });
        syncedCampaigns++;
      }
    }

    // 2) Çalışan testlerdeki varyantlara günlük metrikleri yaz
    const runningTests = await prisma.testRun.findMany({
      where: { status: "RUNNING" },
      include: { variants: true, campaign: true },
    });

    const insightsByAdSet = await fetchAdSetDailyInsights(
      account.accessToken,
      account.adAccountId,
      30
    );

    let syncedMetricPoints = 0;
    for (const test of runningTests) {
      for (const variant of test.variants) {
        if (!variant.metaAdSetId) continue;
        const points = insightsByAdSet[variant.metaAdSetId] ?? [];
        for (const p of points) {
          const date = new Date(`${p.date}T00:00:00.000Z`);
          const spendKurus = Math.round(p.spend * 100);
          const revenueKurus = Math.round(p.revenue * 100);
          await prisma.metricPoint.upsert({
            where: {
              variantId_date: { variantId: variant.id, date },
            },
            update: {
              impressions: p.impressions,
              clicks: p.clicks,
              spendKurus,
              conversions: p.conversions,
              revenueKurus,
              roas: spendKurus > 0 ? revenueKurus / spendKurus : 0,
            },
            create: {
              variantId: variant.id,
              date,
              impressions: p.impressions,
              clicks: p.clicks,
              spendKurus,
              conversions: p.conversions,
              revenueKurus,
              roas: spendKurus > 0 ? revenueKurus / spendKurus : 0,
            },
          });
          syncedMetricPoints++;
        }
      }
    }

    // 3) Meta bağlantı bilgisi güncellendi, ad set listesi UI'da talepleri için kullanılır
    return NextResponse.json({
      demo: false,
      syncedCampaigns,
      syncedMetricPoints,
      message: "Meta senkronizasyonu tamamlandı.",
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Senkronizasyon başarısız" },
      { status: 500 }
    );
  }
}
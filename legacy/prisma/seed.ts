import { prisma } from "@/lib/prisma";
import { mulberry32 } from "@/lib/agent/statistics";

const KURUS = 100;

async function main() {
  console.log("Mevcut veri temizleniyor...");
  await prisma.messageRecord.deleteMany();
  await prisma.followUp.deleteMany();
  await prisma.lead.deleteMany();
  await prisma.mediaAsset.deleteMany();
  await prisma.whatsappConfig.deleteMany();
  await prisma.metricPoint.deleteMany();
  await prisma.agentAction.deleteMany();
  await prisma.variant.deleteMany();
  await prisma.testRun.deleteMany();
  await prisma.campaign.deleteMany();
  await prisma.metaAccount.deleteMany();
  await prisma.clinic.deleteMany();

  const clinic = await prisma.clinic.create({
    data: {
      name: "İstanbul Estetik Kliniği",
      email: "demo@istanbulestetik.com",
    },
  });

  const metaAccount = await prisma.metaAccount.create({
    data: {
      clinicId: clinic.id,
      adAccountId: "act_DEMO_ACCOUNT",
      accessToken: null,
    },
  });

  const campaign = await prisma.campaign.create({
    data: {
      metaAccountId: metaAccount.id,
      metaCampaignId: "DEMO_CAMPAIGN",
      name: "Saç Ekimi - Yurtdışı Paca (Demo)",
      dailyBudgetKurus: 40_000 * KURUS, // 40.000 TL
    },
  });

  // Çalışan A/B testi
  const runningTest = await prisma.testRun.create({
    data: {
      campaignId: campaign.id,
      name: "Görsel A vs Görsel B — ROAS testi",
      status: "RUNNING",
      variants: {
        create: [
          {
            name: "Varyant A — \"Sağlık Turizmi: Türkiye\" görseli",
            metaAdSetId: "DEMO_ADSET_A",
            budgetKurus: 20_000 * KURUS,
            initialBudgetKurus: 20_000 * KURUS,
          },
          {
            name: "Varyant B — Fiyat vurgulu görsel",
            metaAdSetId: "DEMO_ADSET_B",
            budgetKurus: 20_000 * KURUS,
            initialBudgetKurus: 20_000 * KURUS,
          },
        ],
      },
    },
    include: { variants: true },
  });

  const A = runningTest.variants[0];
  const B = runningTest.variants[1];
  const rand = mulberry32(42);
  const now = new Date();

  for (let day = 13; day >= 0; day--) {
    const d = new Date(now);
    d.setDate(now.getDate() - day);
    d.setHours(0, 0, 0, 0);

    const spend = 1800 + rand() * 500; // TL
    const impressions = 4500 + rand() * 2000;
    const clicks = 90 + rand() * 40;

    // A varyantı belirgin şekilde daha iyi ROAS
    const convA = Math.round(1 + rand() * 2);
    const revA = spend * (2.8 + rand() * 0.7);

    const convB = Math.round(0 + rand() * 1.2);
    const revB = spend * (1.2 + rand() * 0.5);

    await prisma.metricPoint.createMany({
      data: [
        {
          variantId: A.id,
          date: d,
          impressions: Math.round(impressions),
          clicks: Math.round(clicks),
          spendKurus: Math.round(spend * KURUS),
          conversions: convA,
          revenueKurus: Math.round(revA * KURUS),
          roas: revA / spend,
        },
        {
          variantId: B.id,
          date: d,
          impressions: Math.round(impressions * 0.9),
          clicks: Math.round(clicks * 0.9),
          spendKurus: Math.round(spend * 0.95 * KURUS),
          conversions: convB,
          revenueKurus: Math.round(revB * KURUS),
          roas: revB / (spend * 0.95),
        },
      ],
    });
  }

  // Bitmiş bir test (kazanan seçilmiş) — geçmiş örnek
  const finishedCampaign = await prisma.campaign.create({
    data: {
      metaAccountId: metaAccount.id,
      metaCampaignId: "DEMO_CAMPAIGN_2",
      name: "Diş Kaplama - Almanya Hedefleme (Demo)",
      dailyBudgetKurus: 25_000 * KURUS,
    },
  });

  const finishedTest = await prisma.testRun.create({
    data: {
      campaignId: finishedCampaign.id,
      name: "Dil varyasyonları A/B testi",
      status: "RUNNING",
      startedAt: new Date(now.getTime() - 21 * 86400_000),
      variants: {
        create: [
          {
            name: "Almanca reklam metni",
            metaAdSetId: "DEMO_ADSET_C",
            budgetKurus: 22_000 * KURUS,
            initialBudgetKurus: 12_000 * KURUS,
          },
          {
            name: "İngilizce reklam metni",
            metaAdSetId: "DEMO_ADSET_D",
            budgetKurus: 3_000 * KURUS,
            initialBudgetKurus: 12_000 * KURUS,
          },
        ],
      },
    },
    include: { variants: true },
  });

  const deWinner = finishedTest.variants.find((v) => v.name.startsWith("Almanca"))!;
  await prisma.testRun.update({
    where: { id: finishedTest.id },
    data: { status: "WINNER_SELECTED", winningVariantId: deWinner.id, endedAt: new Date(now.getTime() - 7 * 86400_000) },
  });

  await prisma.agentAction.createMany({
    data: [
      {
        testRunId: finishedTest.id,
        type: "TEST_START",
        detail: "Test başlatıldı: iki varyant eşit bütçeyle yayına girdi.",
        severity: "INFO",
        createdAt: new Date(now.getTime() - 21 * 86400_000),
      },
      {
        testRunId: finishedTest.id,
        type: "BUDGET_SHIFT",
        detail:
          "Keşif aşaması: \"Almanca reklam metni\" öne geçti (ROAS 4.10, olasılık %78). Bütçenin %15'i kazanana doğru kaydırıldı.",
        severity: "INFO",
        createdAt: new Date(now.getTime() - 14 * 86400_000),
      },
      {
        testRunId: finishedTest.id,
        type: "WINNER_SELECTED",
        detail:
          "Kazanan belirlendi: \"Almanca reklam metni\". ROAS 4.32 vs 1.76 (olasılık: %97.4). Bütçe kazanana aktarıldı.",
        severity: "INFO",
        createdAt: new Date(now.getTime() - 7 * 86400_000),
      },
    ],
  });

  // ---- Demo WhatsApp lead takibi ----
  await prisma.whatsappConfig.create({
    data: {
      clinicId: clinic.id,
      provider: "MOCK",
      fromNumber: "+90 212 000 00 00",
      dailyReminderHour: 10,
      dailyReminderIntervalDays: 1,
      followUpDelayHours: 24,
    },
  });

  const media1 = await prisma.mediaAsset.create({
    data: {
      clinicId: clinic.id,
      name: "Klinik tanıtım görseli",
      type: "IMAGE",
      url: "/uploads/demo-klinik.svg",
      mimeType: "image/svg+xml",
    },
  });

  // Lead 1 — yeni, henüz ilk mesaj gönderilmemiş
  const lead1 = await prisma.lead.create({
    data: {
      clinicId: clinic.id,
      name: "Hans Müller",
      phone: "+49 151 2345 6789",
      country: "DE",
      source: "META_LEAD",
      status: "NEW",
      createdAt: new Date(now.getTime() - 45 * 60_000),
    },
  });

  // Lead 2 — iletişime geçilmiş, dün karşılama gönderildi, takip bekliyor
  const lead2 = await prisma.lead.create({
    data: {
      clinicId: clinic.id,
      name: "Olivia Schmidt",
      phone: "+49 171 8765 4321",
      country: "DE",
      source: "META_LEAD",
      status: "CONTACTED",
      lastOutboundAt: new Date(now.getTime() - 24 * 3600_000),
      createdAt: new Date(now.getTime() - 2 * 86400_000),
    },
  });

  const welcomeSent = new Date(now.getTime() - 24 * 3600_000);
  await prisma.followUp.create({
    data: {
      leadId: lead2.id,
      type: "WELCOME",
      status: "SENT",
      scheduledAt: welcomeSent,
      sentAt: welcomeSent,
    },
  });
  await prisma.messageRecord.create({
    data: {
      leadId: lead2.id,
      direction: "OUTBOUND",
      status: "MOCK",
      body: `Merhaba Olivia Schmidt! İstanbul Estetik Kliniği sağlık turizmi danışmanıyım. Türkiye'de tedavi süreci, fiyatlar ve yolculuk hakkında size nasıl yardımcı olabilirim?`,
      mediaUrl: media1.url,
      mediaType: media1.type,
      providerMessageId: "MOCK_1",
      sentAt: welcomeSent,
    },
  });
  await prisma.followUp.create({
    data: {
      leadId: lead2.id,
      type: "FOLLOWUP",
      scheduledAt: new Date(now.getTime() - 2 * 3600_000), // vadesi geçmiş → çalıştırınca gider
    },
  });

  // Lead 3 — görüşme aşamasında, bugün yanıt vermiş
  const lead3 = await prisma.lead.create({
    data: {
      clinicId: clinic.id,
      name: "Anna Weber",
      phone: "+49 160 1111 2222",
      country: "DE",
      source: "FORM",
      status: "CONVERSING",
      lastOutboundAt: new Date(now.getTime() - 3 * 3600_000),
      lastInboundAt: new Date(now.getTime() - 2 * 3600_000),
      createdAt: new Date(now.getTime() - 4 * 86400_000),
    },
  });

  const reminderSent = new Date(now.getTime() - 26 * 3600_000);
  await prisma.followUp.create({
    data: {
      leadId: lead3.id,
      type: "DAILY_REMINDER",
      status: "SENT",
      scheduledAt: reminderSent,
      sentAt: reminderSent,
    },
  });
  await prisma.messageRecord.create({
    data: {
      leadId: lead3.id,
      direction: "OUTBOUND",
      status: "MOCK",
      body: `Sayın Anna Weber,İstanbul Estetik Kliniği ekibi olarak yanınızdayız.`,
      providerMessageId: "MOCK_2",
      sentAt: reminderSent,
    },
  });
  await prisma.messageRecord.create({
    data: {
      leadId: lead3.id,
      direction: "INBOUND",
      status: "RECEIVED",
      body: "Merhaba, fiyat listesini gönderebilir misiniz?",
      providerMessageId: "MOCK_3",
      sentAt: new Date(now.getTime() - 2 * 3600_000),
    },
  });

  console.log("✅ Demo veri eklendi:");
  console.log("  Klinik     :", clinic.name);
  console.log("  Test (çalışıyor):", runningTest.name);
  console.log("  Test (bitmiş)  :", finishedTest.name);
  console.log("  WhatsApp lead  :", [lead1.name, lead2.name, lead3.name].join(", "));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
import { env } from "process";
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "crypto";
import { promisify } from "util";

import { loadEnv } from "@admedic/config";
import { mulberry32, seedFromString, toMinor } from "@admedic/shared";

import { prisma } from "../src";
import {
  Role,
  EntityStatus,
  ExperimentStatus,
  VariantRole,
  AgentDecisionAction,
  AgentTargetType,
  ApprovalStatus,
  AlertType,
  AlertSeverity,
} from "@prisma/client";

const scrypt = promisify(scryptCb) as (p: string, s: string, k: number) => Promise<Buffer>;

/** Login (`web/app/_lib/password`) ile aynı `scrypt:salt:key` formatı. */
async function scryptHash(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const key = await scrypt(password, salt, 64);
  return `scrypt:${salt}:${key.toString("hex")}`;
}
async function isScryptAndMatches(password: string, encoded: string | null): Promise<boolean> {
  const match = /^scrypt:([a-f0-9]{32}):([a-f0-9]{128})$/.exec(encoded ?? "");
  if (!match) return false;
  const key = await scrypt(password, match[1], 64);
  return timingSafeEqual(key, Buffer.from(match[2], "hex"));
}

loadEnv({ fresh: true });

const DEMO_EMAIL = "admin@admedic.io";
const DEMO_PASSWORD = "demo1234";

function dateKeyUTC(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Deterministik günlük insight üretimi (mock Meta verisi)
interface CampaignProfile {
  aovEuro: number;
  targetRoas: number;
}

const PROFILES: Record<string, CampaignProfile> = {
  "Germany - Hair Restoration": { aovEuro: 2900, targetRoas: 4.5 },
  "UK - Hair Restoration": { aovEuro: 2700, targetRoas: 4.2 },
  "France - Dental Implants": { aovEuro: 3400, targetRoas: 4.0 },
  "Gulf - Body Contouring": { aovEuro: 4200, targetRoas: 3.8 },
  "RU-KZ - Check-up Package": { aovEuro: 1600, targetRoas: 5.2 },
};

/**
 * Önceki turda oluşturulan demo verisini FK-güvenli sırayla temizler.
 * (seed idempotent: yeniden çalıştırma çakışmadan yeni veri üretir)
 */
async function clearDemoData(orgId: string, workspaceId: string) {
  const expIds = (
    await prisma.experiment.findMany({ where: { workspaceId }, select: { id: true } })
  ).map((e) => e.id);
  const inExp = (field: "experimentId" | "variantId") =>
    expIds.length > 0 ? { [field]: { in: expIds } } : {};

  await prisma.budgetChange.deleteMany({ where: { workspaceId } });
  await prisma.agentDecision.deleteMany({ where: { workspaceId } });
  await prisma.experimentMetricPoint.deleteMany({ where: inExp("experimentId") });
  await prisma.experimentVariant.deleteMany({ where: inExp("experimentId") });
  await prisma.experiment.deleteMany({ where: { workspaceId } });
  await prisma.conversionEvent.deleteMany({ where: { workspaceId } });
  await prisma.insightSnapshot.deleteMany({ where: { workspaceId } });
  await prisma.ad.deleteMany({ where: { workspaceId } });
  await prisma.adSet.deleteMany({ where: { workspaceId } });
  await prisma.campaign.deleteMany({ where: { workspaceId } });
  await prisma.adAccount.deleteMany({ where: { orgId } });
  await prisma.creative.deleteMany({ where: { orgId } });
  await prisma.product.deleteMany({ where: { workspaceId } });
  await prisma.landingPage.deleteMany({ where: { workspaceId } });
  await prisma.alert.deleteMany({ where: { workspaceId } });
  await prisma.auditLog.deleteMany({ where: { workspaceId } });
  await prisma.optimizationRule.deleteMany({ where: { workspaceId } });
  await prisma.optimizationPolicy.deleteMany({ where: { workspaceId } });
  await prisma.membership.deleteMany({ where: { orgId } });
}

async function main() {
  console.log("🌱 Admedic demo verisi oluşturuluyor…");

  const org = await prisma.organization.upsert({
    where: { slug: "askmed-demo" },
    update: {},
    create: { name: "AskMed Demo Klinik", slug: "askmed-demo" },
  });

  const adminUser = await prisma.user.upsert({
    where: { email: DEMO_EMAIL },
    update: { name: "Demo Admin" },
    create: {
      email: DEMO_EMAIL,
      name: "Demo Admin",
      passwordHash: await scryptHash(DEMO_PASSWORD),
    },
  });
  if (!(await isScryptAndMatches(DEMO_PASSWORD, adminUser.passwordHash))) {
    await prisma.user.update({
      where: { id: adminUser.id },
      data: { passwordHash: await scryptHash(DEMO_PASSWORD) },
    });
    console.log("  Demo admin parolası scrypt formatına onarıldı.");
  }
  const viewerUser = await prisma.user.upsert({
    where: { email: "viewer@admedic.io" },
    update: {},
    create: {
      email: "viewer@admedic.io",
      name: "Demo Viewer",
      passwordHash: await scryptHash("viewer1234"),
    },
  });
  if (!(await isScryptAndMatches("viewer1234", viewerUser.passwordHash))) {
    await prisma.user.update({
      where: { id: viewerUser.id },
      data: { passwordHash: await scryptHash("viewer1234") },
    });
    console.log("  Demo viewer parolası scrypt formatına onarıldı.");
  }

  const workspace = await prisma.workspace.upsert({
    where: { orgId_slug: { orgId: org.id, slug: "ana-workspace" } },
    update: {},
    create: { orgId: org.id, name: "Ana Çalışma Alanı", slug: "ana-workspace", currency: "EUR", agentStatus: "ACTIVE" },
  });

  await clearDemoData(org.id, workspace.id);
  console.log("  Önceki demo veri temizlendi (idempotent yeniden çalıştırma).");

  // clearDemoData membership.deleteMany çalıştırdığı için üyelikler en sona kurulur.
  await prisma.membership.upsert({
    where: { orgId_userId: { orgId: org.id, userId: adminUser.id } },
    update: { role: Role.OWNER },
    create: { orgId: org.id, userId: adminUser.id, role: Role.OWNER, status: "ACTIVE" },
  });
  await prisma.membership.upsert({
    where: { orgId_userId: { orgId: org.id, userId: viewerUser.id } },
    update: { role: Role.VIEWER },
    create: { orgId: org.id, userId: viewerUser.id, role: Role.VIEWER, status: "ACTIVE" },
  });

  await prisma.optimizationPolicy.upsert({
    where: { workspaceId: workspace.id },
    update: {},
    create: {
      workspaceId: workspace.id,
      objective: "MAX_ROAS",
      mode: "APPROVAL",
      accountDailyMaxCents: toMinor(10000),
      accountMonthlyMaxCents: toMinor(300000),
      minDailyBudgetCents: toMinor(5),
      maxDailyBudgetCents: toMinor(3000),
      maxIncreasePct: 20,
      maxDecreasePct: 20,
      maxChangePer24hPct: 50,
      minHoursBetweenChanges: 6,
      minSpendBeforeDecisionCents: toMinor(100),
      minPurchasesBeforeScaling: 10,
      minTestDurationHours: 24,
      explorationPct: 15,
      exploitationPct: 85,
      targetRoas: 4,
      maxCpaCents: toMinor(600),
      stopLossSpendCents: toMinor(400),
      stopLossPurchases: 0,
      attributionWindowDays: 7,
    },
  });

  // Guardrail kuralının sürümlü tanımı (policy v1)
  await prisma.optimizationRule.create({
    data: {
      workspaceId: workspace.id,
      name: "policy_v1",
      version: "policy_1",
      active: true,
      description: "Guardrail + scale/downscale + stop-loss kuralları (rules_v1)",
      logic: { rules: ["financial_guardrails", "scale_thresholds", "downscale_thresholds", "stop_loss", "cooldown", "exploration_split"] },
    },
  }).catch(() => undefined);

  const adAccounts = await Promise.all(
    ["act_demo_eu", "act_demo_us"].map(async (metaAcc, idx) => {
      return prisma.adAccount.upsert({
        where: { orgId_metaAccountId: { orgId: org.id, metaAccountId: metaAcc } },
        update: {},
        create: {
          orgId: org.id,
          workspaceId: workspace.id,
          metaAccountId: metaAcc,
          name: idx === 0 ? "EU Account (Demo)" : "US Account (Demo)",
          currency: "EUR",
          timezone: "Europe/Istanbul",
          status: EntityStatus.ACTIVE,
          isDefault: idx === 0,
          dailySpendLimit: toMinor(6000),
        },
      });
    }),
  );

  const campaignDefs = [
    { name: "Germany - Hair Restoration", acc: 0 },
    { name: "UK - Hair Restoration", acc: 0 },
    { name: "France - Dental Implants", acc: 0 },
    { name: "Gulf - Body Contouring", acc: 1 },
    { name: "RU-KZ - Check-up Package", acc: 1 },
  ];

  const adsets: { id: string; campaignId: string; workspaceId: string }[] = [];
  const ads: Awaited<ReturnType<typeof prisma.ad.create>>[] = [];

  for (const [ci, def] of campaignDefs.entries()) {
    const campaign = await prisma.campaign.upsert({
      where: { adAccountId_metaCampaignId: { adAccountId: adAccounts[def.acc]!.id, metaCampaignId: `cmp_${ci + 1}` } },
      update: {},
      create: {
        adAccountId: adAccounts[def.acc]!.id,
        workspaceId: workspace.id,
        metaCampaignId: `cmp_${ci + 1}`,
        name: def.name,
        objective: "OUTCOME_LEADS",
        status: EntityStatus.ACTIVE,
        budgetType: "DAILY",
        dailyBudget: toMinor(500),
        syncStatus: "OK",
      },
    });

    for (let a = 0; a < 2; a++) {
      const adset = await prisma.adSet.create({
        data: {
          campaignId: campaign.id,
          workspaceId: workspace.id,
          metaAdSetId: `as_${ci}_${a}`,
          name: `${def.name} — AdSet ${a + 1}`,
          status: EntityStatus.ACTIVE,
          bidStrategy: "LOWEST_COST_WITHOUT_CAP",
          dailyBudget: toMinor(150),
          targeting: { countries: [], minAge: 25, maxAge: 65 },
          syncStatus: "OK",
        },
      });
      adsets.push(adset);

      for (let i = 0; i < 5; i++) {
        const ad = await prisma.ad.create({
          data: {
            adSetId: adset.id,
            workspaceId: workspace.id,
            metaAdId: `ad_${ci}_${a}_${i}`,
            name: `${def.name} — Ad ${i + 1} (${a === 0 ? "CTRL" : "VAR"})`,
            status: EntityStatus.ACTIVE,
            metaCreativeId: `cr_${ci}_${a}_${i}`,
            syncStatus: "OK",
          },
        });
        ads.push(ad);
      }
    }
  }

  const creativeNames = [
    "Creative #1 — Fotoğraflı Hikaye",
    "Creative #2 — Video Testimonial",
    "Creative #3 — Carousel Başarı",
    "Creative #4 — İstatistik Post",
    "Creative #5 — Uzman Röportajı",
    "Creative #6 — Fotoğraflı Hikaye DE",
    "Creative #7 — Video Muayene Turu",
    "Creative #8 — Karusel AR",
    "Creative #9 — Check-up Paket",
    "Creative #10 — Diş Gülümseme",
  ];
  for (let c = 0; c < 10; c++) {
    await prisma.creative.upsert({
      where: { orgId_metaCreativeId: { orgId: org.id, metaCreativeId: `creative_${c + 1}` } },
      update: {},
      create: {
        orgId: org.id,
        workspaceId: workspace.id,
        name: creativeNames[c],
        type: c % 3 === 1 ? "VIDEO" : c % 3 === 2 ? "CAROUSEL" : "IMAGE",
        metaCreativeId: `creative_${c + 1}`,
        primaryText: c % 2 === 0 ? "Saç ekimi deneyiminiz burada başlar." : "Gülüşünüzü yeniden kazanın.",
        headline: c % 2 === 0 ? "Saç Ekimi" : "Diş İmplantları",
        description: "Ücretsiz konsültasyon",
        cta: "WhatsApp'tan Yazın",
        status: "ACTIVE",
      },
    });
  }

  // ------------------------------------------------------------------ Insights (30 gün, ad seviyesi)
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let insightCount = 0;
  for (const ad of ads) {
    // Varyantlara deterministik latent kalite: CTRL ortalama, VAR kimi güçlü kimi zayıf
    const adSeed = seedFromString(ad.name + ad.metaAdId);
    const quality = 0.55 + mulberry32(adSeed + 1)() * 1.1; // ~0.55–1.65
    const campaign = campaignDefs.find((d) => ad.name.startsWith(d.name));
    const profile = PROFILES[campaign?.name ?? ""]!;

    for (let d = 0; d < 30; d++) {
      const day = new Date(today.getTime() - d * 86400_000);
      const key = dateKeyUTC(day);
      const daySeed = seedFromString(`${ad.metaAdId}:${key}`);
      const rnd = mulberry32(daySeed);

      const spendMajor = 40 + rnd() * 160; // ~€40–200
      const spend = toMinor(spendMajor);
      const freq = 1.4 + rnd() * 1.6;
      const impressions = Math.round((spendMajor / (2.5 + rnd() * 3)) * 1000);
      const clicks = Math.round(impressions * (0.008 + rnd() * 0.014));
      const ctr = clicks / Math.max(impressions, 1);
      const purchases = Math.floor(rnd() * rnd() * 7);
      const convValue = purchases > 0 ? toMinor(profile.aovEuro * purchases * (0.85 + rnd() * 0.3)) : 0;
      const roasBoost = 0.75 + quality * (0.5 + rnd() * 0.7);
      const roasActual = profile.targetRoas * roasBoost;

      await prisma.insightSnapshot.create({
        data: {
          workspaceId: ad.workspaceId,
          adId: ad.id,
          date: day,
          granularity: "DAILY",
          attributionWindowDays: 7,
          source: "MOCK",
          spend,
          impressions,
          reach: Math.round(impressions * 0.8),
          clicks,
          linkClicks: Math.round(clicks * 0.6),
          outboundClicks: Math.round(clicks * 0.5),
          landingPageViews: Math.round(clicks * 0.4),
          addsToCart: Math.round(purchases * 1.2),
          initiatesCheckout: Math.round(purchases * 1.05),
          purchases,
          conversionValue: convValue,
          frequency: Number(freq.toFixed(2)),
          ctr: Number(ctr.toFixed(5)),
          cpc: clicks > 0 ? Math.round(spend / clicks) : 0,
          cpm: Math.round(spend / 1000),
        },
      });
      insightCount++;
    }
  }
  console.log(`  Insights (ad seviyesi, 30 gün): ${insightCount}`);

  // ------------------------------------------------------------------ Deneyler
  const expDefs = [
    { name: "Germany — Yeni Görsel vs Mevcut", status: ExperimentStatus.RUNNING, vars: 2, creativeCount: 2 },
    { name: "France — Video vs Carousel", status: ExperimentStatus.RUNNING, vars: 2, creativeCount: 2 },
    { name: "Gulf — AR Metin Varyasyonu", status: ExperimentStatus.COMPLETED, vars: 2, creativeCount: 1 },
    { name: "RU-KZ — Check-up CTA Testi", status: ExperimentStatus.COMPLETED, vars: 2, creativeCount: 1 },
    { name: "UK — Yeni Header Adayı", status: ExperimentStatus.PAUSED, vars: 3, creativeCount: 2 },
    { name: "Germany — Deneme Sedo Modu", status: ExperimentStatus.DRAFT, vars: 2, creativeCount: 1 },
  ];

  for (const [ei, def] of expDefs.entries()) {
    const exp = await prisma.experiment.upsert({
      where: { id: `exp_${ei + 1}` },
      update: {},
      create: {
        id: `exp_${ei + 1}`,
        workspaceId: workspace.id,
        adAccountId: adAccounts[ei < 3 ? 0 : 1]!.id,
        name: def.name,
        hypothesis: def.name === "France — Video vs Carousel" ? "Video, carousel'den daha yüksek ROAS üretir." : null,
        primaryMetric: "ROAS",
        status: def.status,
        mode: "MANUAL",
        minSpend: toMinor(100),
        maxSpend: toMinor(1500),
        minPurchases: 10,
        minRuntimeHours: 72,
        confidenceThreshold: 0.95,
        budgetCents: toMinor(500),
        startDate: def.status === ExperimentStatus.COMPLETED ? new Date(today.getTime() - 12 * 86400_000) : def.status === ExperimentStatus.RUNNING ? new Date(today.getTime() - 4 * 86400_000) : undefined,
        endDate: def.status === ExperimentStatus.COMPLETED ? new Date(today.getTime() - 3 * 86400_000) : undefined,
      },
    });

    for (let v = 0; v < def.vars; v++) {
      await prisma.experimentVariant.create({
        data: {
          experimentId: exp.id,
          role: v === 0 ? VariantRole.CONTROL : VariantRole.TEST,
          name: def.vars === 2 ? (v === 0 ? "A (Kontrol)" : "B (Varyant)") : v === 0 ? "A (Kontrol)" : `Varyant ${String.fromCharCode(65 + v)}`,
          dailyBudgetCents: toMinor(250),
          isWinner: def.status === ExperimentStatus.COMPLETED && v === 1,
          config: {},
        },
      });
    }

    // Örnek metrik noktaları (birkaç günlük)
    for (let d = def.status === ExperimentStatus.COMPLETED ? 1 : 0; d < (def.status === ExperimentStatus.COMPLETED ? 4 : 2); d++) {
      const vars = await prisma.experimentVariant.findMany({ where: { experimentId: exp.id } });
      for (const v of vars) {
        const rnd = mulberry32(seedFromString(`${exp.id}:${v.id}:d${d}`));
        const purchases = 2 + Math.floor(rnd() * 6);
        const ctr = 0.9 + rnd() * 1.4;
        await prisma.experimentMetricPoint.create({
          data: {
            experimentId: exp.id,
            variantId: v.id,
            capturedAt: new Date(today.getTime() - d * 86400_000),
            spend: toMinor(200 + rnd() * 150),
            revenue: toMinor((3200 + rnd() * 2800) * purchases),
            purchases,
            impressions: Math.round((200 + rnd() * 150) / (1.8 + rnd()) * 1000),
            clicks: Math.round((200 + rnd() * 150) * (ctr / 100) * 10),
            ctr: Number(ctr.toFixed(4)),
          },
        });
      }
    }
  }

  const decisionDefs: {
    adIdx: number;
    action: AgentDecisionAction;
    deltaPct: number;
    reason: string;
    key: string;
    approval: ApprovalStatus;
    trend: "RISING" | "DECLINING";
  }[] = [
    { adIdx: 6, action: AgentDecisionAction.INCREASE_BUDGET, deltaPct: 20, reason: "7-gün ROAS 6.2 hedef 4.5'in %38 üzerinde. 48 satın alma ile performans 72 saat stabil.", key: "dec_1", approval: "APPROVED", trend: "RISING" },
    { adIdx: 22, action: AgentDecisionAction.INCREASE_BUDGET, deltaPct: 15, reason: "Son 72 saatte ROAS 4.3 → 6.8. Güven %97.", key: "dec_2", approval: "APPROVED", trend: "RISING" },
    { adIdx: 45, action: AgentDecisionAction.DECREASE_BUDGET, deltaPct: -15, reason: "ROAS 2.9, hedef 4.5'in altında ve trend negatif. Sample yeterli, durdurulmadı.", key: "dec_3", approval: "APPROVED", trend: "DECLINING" },
    { adIdx: 9, action: AgentDecisionAction.DECREASE_BUDGET, deltaPct: -20, reason: "Harcama 7 gündür eşik üstü, 0 satın alma tespit edilmedi ancak CPL artıyor.", key: "dec_4", approval: "PENDING", trend: "DECLINING" },
    { adIdx: 31, action: AgentDecisionAction.PAUSE, deltaPct: 0, reason: "Stop-loss: €980 harcandı, satın alma yok.", key: "dec_5", approval: "APPROVED", trend: "DECLINING" },
    { adIdx: 3, action: AgentDecisionAction.INCREASE_BUDGET, deltaPct: 10, reason: "Yeni winner tanımlama: keşif bütçesinden kayma.", key: "dec_6", approval: "APPROVED", trend: "RISING" },
    { adIdx: 40, action: AgentDecisionAction.DECREASE_BUDGET, deltaPct: -5, reason: "Yaratıcı yorgunluk: frekans 3.1, CTR -18%.", key: "dec_7", approval: "PENDING", trend: "DECLINING" },
    { adIdx: 17, action: AgentDecisionAction.PAUSE, deltaPct: 0, reason: "CPA €780 > maks €600 örneği yeterli.", key: "dec_8", approval: "PENDING", trend: "DECLINING" },
    { adIdx: 27, action: AgentDecisionAction.INCREASE_BUDGET, deltaPct: 18, reason: "Fransa pazarı yeterli hacim: yeni deney önerildi.", key: "dec_9", approval: "APPROVED", trend: "RISING" },
    { adIdx: 13, action: AgentDecisionAction.KEEP, deltaPct: 0, reason: "Performans stabil, değişiklik gerekmiyor.", key: "dec_10", approval: "NOT_REQUIRED", trend: "RISING" },
  ];

  const run1 = await prisma.agentRun.create({
    data: {
      workspaceId: workspace.id,
      mode: "AUTOPILOT",
      objective: "MAX_ROAS",
      status: "COMPLETED",
      agentVersion: "agent_v1.0",
      policyVersion: 1,
      startedAt: new Date(today.getTime() - 1 * 86400_000 - 3600_000),
      finishedAt: new Date(today.getTime() - 1 * 86400_000),
    },
  });

  for (const dd of decisionDefs) {
    const ad = ads[dd.adIdx];
    if (!ad) continue;
    const metrics = await prisma.insightSnapshot.aggregate({
      where: { adId: ad.id, date: { gte: new Date(today.getTime() - 7 * 86400_000) } },
      _sum: { spend: true, conversionValue: true, purchases: true },
    });
    const spend = metrics._sum.spend ?? 0;
    const revenue = metrics._sum.conversionValue ?? 0;
    const purchases = metrics._sum.purchases ?? 0;
    const oldBudget = toMinor(120);
    const newBudget = dd.action === AgentDecisionAction.INCREASE_BUDGET ? Math.round(oldBudget * (1 + dd.deltaPct / 100)) : dd.action === AgentDecisionAction.DECREASE_BUDGET ? Math.round(oldBudget * (1 + dd.deltaPct / 100)) : oldBudget;

    const decision = await prisma.agentDecision.upsert({
      where: { decisionKey: dd.key },
      update: {},
      create: {
        workspaceId: workspace.id,
        runId: run1.id,
        targetType: AgentTargetType.AD,
        targetId: ad.id,
        action: dd.action,
        statusBefore: "ACTIVE",
        statusAfter: dd.action === "PAUSE" ? "PAUSED" : "ACTIVE",
        budgetBefore: dd.action === "PAUSE" ? null : oldBudget,
        budgetAfter: dd.action === "PAUSE" ? null : newBudget,
        changePct: dd.deltaPct,
        approval: dd.approval,
        reason: dd.reason,
        metricsSnapshot: { spend, revenue, purchases, roas: spend > 0 ? Number((revenue / spend).toFixed(2)) : 0 },
        trendDirection: dd.trend,
        algorithm: "rules_v1",
        ruleVersion: "policy_1",
        agentVersion: "agent_v1.0",
        decisionKey: dd.key,
        appliedAt: dd.approval === "APPROVED" && dd.action !== "KEEP" ? new Date(today.getTime() - 86400_000) : null,
      },
    });

    if (dd.action !== AgentDecisionAction.KEEP) {
      await prisma.budgetChange.upsert({
        where: { idempotencyKey: `bc_${dd.key}` },
        update: {},
        create: {
          workspaceId: workspace.id,
          decisionId: decision.id,
          targetType: AgentTargetType.AD,
          targetId: ad.id,
          field: "daily_budget",
          fromCents: oldBudget,
          toCents: newBudget,
          status: "APPLIED",
          idempotencyKey: `bc_${dd.key}`,
          appliedAt: decision.appliedAt,
        },
      });
    }
  }
  console.log("  Agent kararları: 10");

  // ------------------------------------------------------------------ Uyarılar + denetim + ürün + landing page
  await prisma.alert.createMany({
    data: [
      { workspaceId: workspace.id, type: AlertType.WINNER_DETECTED, severity: AlertSeverity.INFO, status: "RESOLVED", title: "Kazanan tespit edildi", message: "Germany — Yeni Görsel testinde B varyantı %95 güvenle kazandı.", entityType: "experiment", entityId: "exp_3", read: true, resolvedAt: new Date(today.getTime() - 2 * 86400_000) },
      { workspaceId: workspace.id, type: AlertType.ROAS_DROP, severity: AlertSeverity.CRITICAL, status: "OPEN", title: "ROAS düşüşü: Campaign #4 (Gulf)", message: "Son 24 saatte reklam getirisi (ROAS) önceki güne göre %52 düştü.", entityType: "CAMPAIGN", entityId: "cmp_4", read: false },
      { workspaceId: workspace.id, type: AlertType.HIGH_CPA, severity: AlertSeverity.WARNING, status: "OPEN", title: "Yüksek satın alma maliyeti", message: "Bir reklamda satın alma başına maliyet €780'e çıktı; hedefin üzerinde.", entityType: "AD", entityId: "ad_1_1_2", read: false },
    ],
  });

  await prisma.auditLog.createMany({
    data: [
      { orgId: org.id, workspaceId: workspace.id, userId: adminUser.id, action: "POLICY_UPDATE", entityType: "OptimizationPolicy", entityId: "policy", after: { mode: "APPROVAL", targetRoas: 4 }, ip: "127.0.0.1" },
      { orgId: org.id, workspaceId: workspace.id, userId: adminUser.id, action: "DECISION_APPROVE", entityType: "AgentDecision", entityId: "dec_1", after: { approval: "APPROVED" }, ip: "127.0.0.1" },
      { orgId: org.id, workspaceId: workspace.id, userId: adminUser.id, action: "EXPERIMENT_CREATE", entityType: "Experiment", entityId: "exp_1", after: { name: "Germany — Yeni Görsel vs Mevcut" }, ip: "127.0.0.1" },
    ],
  });

  const products = [
    { name: "Saç Ekimi (FUE)", category: "Hair", selling: 2900, cogs: 650, shipping: 0 },
    { name: "Saç Ekimi (DHI)", category: "Hair", selling: 3400, cogs: 780, shipping: 0 },
    { name: "Diş İmplantı (Tek Diş)", category: "Dental", selling: 950, cogs: 320, shipping: 0 },
    { name: "Check-up Paket", category: "Checkup", selling: 550, cogs: 140, shipping: 0 },
  ];
  for (const p of products) {
    await prisma.product.create({
      data: {
        workspaceId: workspace.id,
        name: p.name,
        category: p.category,
        sellingPriceCents: toMinor(p.selling),
        cogsCents: toMinor(p.cogs),
        shippingCents: toMinor(p.shipping),
        otherCostsCents: toMinor(25),
        refundRatePct: 1.5,
      },
    });
  }

  await prisma.landingPage.createMany({
    data: [
      { workspaceId: workspace.id, name: "Saç Ekimi Landing", url: "https://askmed.example/hair" },
      { workspaceId: workspace.id, name: "Diş Landing", url: "https://askmed.example/dental" },
      { workspaceId: workspace.id, name: "WhatsApp Form", url: "https://wa.me/905551112233" },
    ],
  });

  console.log("  Uyarılar: 3, Denetim: 3, Ürün: 4, Landing: 3");
  console.log("✅ Demo veri tamam.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

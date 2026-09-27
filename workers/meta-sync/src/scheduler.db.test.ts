import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";

const { sendWeeklyReportEmail } = vi.hoisted(() => ({ sendWeeklyReportEmail: vi.fn() }));
vi.mock("@admedic/reporting", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@admedic/reporting")>()),
  sendWeeklyReportEmail,
}));

import { prisma } from "@admedic/database";
import { loadEnv } from "@admedic/config";
import { MetaGraphError, type MetaClientLike, type MetaInsightRow } from "@admedic/meta-api";
import {
  deliverWeeklyReport,
  isMetaThrottleError,
  REVIEW_INTERVAL_ACTIVE_MS,
  runAnomalyAlerts,
  syncAdReviews,
  syncInsights,
} from "./scheduler";

function insightRow(date: string, overrides: Partial<MetaInsightRow> = {}): MetaInsightRow {
  return {
    dateStart: date, dateStop: date, impressions: 1000, reach: 800, frequency: 1.25, clicks: 20, linkClicks: 12,
    ctr: 0.02, cpc: 1.5, cpm: 3.25, spendMajor: 12.345, purchases: 1, purchaseValueMajor: 100, leads: 2,
    addsToCart: 0, initiatesCheckout: 0, ...overrides,
  };
}

function stubClient(behaviour: Record<string, () => Promise<MetaInsightRow[]>>): MetaClientLike {
  const fail = () => Promise.reject(new Error("beklenmeyen çağrı"));
  return {
    getVersion: () => "v0.0",
    getAdAccounts: fail,
    listAdSets: fail,
    listAds: fail,
    updateBudget: fail,
    setStatus: fail,
    createCampaign: fail,
    getAdReview: fail,
    async listCampaigns(accountId: string) {
      // Throttle senaryosu: listCampaigns'ta rate limit hatası → hesap atlanır.
      if (accountId === "throttle") throw new MetaGraphError({ code: 613, message: "Calls to this api have exceeded the rate limit." });
      if (accountId === "boom") throw new Error("db down");
      if (!behaviour[accountId]) throw new MetaGraphError({ code: 100, message: "bilinmeyen hesap" });
      return [{ id: `cmp_${accountId}`, name: `Kampanya ${accountId}`, objective: "OUTCOME_LEADS", status: "ACTIVE" }];
    },
    async getInsights(ref: { type: string; id: string }) {
      const rows = behaviour[ref.id.replace(/^cmp_/, "")];
      return rows ? rows() : [];
    },
  } as unknown as MetaClientLike;
}

describe.skipIf(!process.env.DATABASE_URL && !loadEnv().DATABASE_URL)("meta-sync worker (DB)", () => {
  const suffix = randomBytes(6).toString("hex");
  let orgId = "";
  let workspaceId = "";
  let connectionId = "";
  let kwdAccountId = "";
  let throttleAccountId = "";
  const todayDow = new Date().getUTCDay();

  beforeAll(async () => {
    loadEnv({ fresh: true, overrides: { META_MOCK_MODE: "true", WEEKLY_REPORT_DAY: String(todayDow), RESEND_API_KEY: "re_test", RESEND_FROM: "raporlar@example.invalid", WEEKLY_REPORT_RECIPIENT: "" } });
    const org = await prisma.organization.create({
      data: { name: "Worker fixture", slug: `worker-${suffix}`, workspaces: { create: { name: "W", slug: "w" } } },
      include: { workspaces: true },
    });
    orgId = org.id;
    workspaceId = org.workspaces[0]!.id;
    const conn = await prisma.metaConnection.create({ data: { orgId, type: "AD_ACCOUNT", status: "CONNECTED" } });
    connectionId = conn.id;
    kwdAccountId = (await prisma.adAccount.create({
      data: { orgId, workspaceId, connectionId, name: "KWD hesabı", currency: "KWD", metaAccountId: `act_kwd${suffix}` },
    })).id;
    throttleAccountId = (await prisma.adAccount.create({
      data: { orgId, workspaceId, connectionId, name: "Throttle", currency: "EUR", metaAccountId: "act_throttle" },
    })).id;
  });
  beforeEach(() => { sendWeeklyReportEmail.mockReset().mockResolvedValue({ id: "email_1" }); });
  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: orgId } });
    loadEnv({ fresh: true });
    await prisma.$disconnect();
  });

  async function workspaceWithAccounts() {
    return prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId }, include: { adAccounts: { include: { connection: true } } } });
  }

  it("insight tutarlarını hesap para birimine göre minor unit yazar; throttle hesabını atlar", async () => {
    // Tarihler bugüne göre 60/59 gün önce: anomali testinin 14 günlük penceresine hiçbir zaman
    // düşmez (sabit tarih kullanıldığında 2026-09-27'den itibaren fazladan SPEND_SPIKE üretiyordu).
    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
    const meta = stubClient({ [`kwd${suffix}`]: async () => [insightRow(daysAgo(60)), insightRow(daysAgo(59), { cpc: undefined, cpm: undefined })] });
    const synced = await syncInsights(meta, await workspaceWithAccounts());
    expect(synced).toBe(2);
    const rows = await prisma.insightSnapshot.findMany({ where: { workspaceId, adAccountId: kwdAccountId }, orderBy: { date: "asc" } });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.spend).toBe(12_345); // 12.345 KWD → 3 ondalık
    expect(rows[0]!.conversionValue).toBe(100_000);
    expect(rows[0]!.cpc).toBe(1_500);
    expect(rows[0]!.cpm).toBe(3_250);
    expect(rows[0]!.ctr).toBeCloseTo(0.02, 6);
    expect(rows[1]!.cpc).toBeNull();
    expect(rows[1]!.cpm).toBeNull();
    // Throttle hesabı için kampanya oluşturulmadı, diğer hesap etkilenmedi.
    expect(await prisma.campaign.count({ where: { adAccountId: throttleAccountId } })).toBe(0);
    expect(await prisma.campaign.count({ where: { adAccountId: kwdAccountId } })).toBe(1);
    // Tekrar senkron aynı günü günceller, çoğaltmaz.
    expect(await syncInsights(meta, await workspaceWithAccounts())).toBe(2);
    expect(await prisma.insightSnapshot.count({ where: { workspaceId, adAccountId: kwdAccountId } })).toBe(2);
  });

  it("Meta dışı hatalar yukarı fırlatılır (workspace düzeyinde yakalanır)", async () => {
    await prisma.adAccount.update({ where: { id: throttleAccountId }, data: { metaAccountId: "act_boom" } });
    const meta = stubClient({ boom: async () => [] });
    await expect(syncInsights(meta, await workspaceWithAccounts())).rejects.toThrow("db down");
    await prisma.adAccount.update({ where: { id: throttleAccountId }, data: { metaAccountId: "act_throttle" } });
    expect(isMetaThrottleError(new MetaGraphError({ code: 80004, message: "x" }))).toBe(true);
    expect(isMetaThrottleError(new MetaGraphError({ code: 100, message: "x" }))).toBe(false);
    expect(isMetaThrottleError(new Error("x"))).toBe(false);
  });

  it("kampanya bütçesini (CBO kampanya, ABO aktif ad set toplamı) ve Meta durumunu yerele yansıtır", async () => {
    const budgetAccountId = (await prisma.adAccount.create({
      data: { orgId, workspaceId, connectionId, name: "Bütçe", currency: "EUR", metaAccountId: `act_budget${suffix}` },
    })).id;
    const partial = await prisma.campaign.create({ data: {
      adAccountId: budgetAccountId, workspaceId, name: "Yarım yayın", metaCampaignId: `cmp_partial${suffix}`,
      workflowStatus: "APPROVED", status: "PAUSED", dailyBudget: 1_000,
    } });
    let round = 1;
    const listAdSets = vi.fn(async () => [
      { id: "as1", campaignId: `cmp_abo${suffix}`, name: "a", status: "ACTIVE", dailyBudgetCents: 3_000 },
      { id: "as2", campaignId: `cmp_abo${suffix}`, name: "b", status: "ACTIVE", dailyBudgetCents: 2_000 },
      { id: "as3", campaignId: `cmp_abo${suffix}`, name: "c", status: "PAUSED", dailyBudgetCents: 9_999 },
    ]);
    const meta = {
      listAdSets,
      async listCampaigns(accountId: string) {
        if (accountId !== `budget${suffix}`) throw new MetaGraphError({ code: 100, message: "bilinmeyen hesap" });
        return [
          { id: `cmp_cbo${suffix}`, name: "CBO", status: round === 1 ? "ACTIVE" : "PAUSED", dailyBudgetCents: round === 1 ? 5_000 : 7_000 },
          { id: `cmp_abo${suffix}`, name: "ABO", status: "ACTIVE" },
          { id: `cmp_life${suffix}`, name: "Ömür", status: round === 1 ? "PAUSED" : "ARCHIVED", lifetimeBudgetCents: 100_000 },
          { id: `cmp_partial${suffix}`, name: "Yarım yayın", status: "ACTIVE", dailyBudgetCents: 9_000 },
        ];
      },
      async getInsights() { return []; },
    } as unknown as MetaClientLike;
    await syncInsights(meta, await workspaceWithAccounts());
    const byMeta = async () => new Map(
      (await prisma.campaign.findMany({ where: { adAccountId: budgetAccountId } })).map((c) => [c.metaCampaignId!.replace(suffix, ""), c]),
    );
    let rows = await byMeta();
    expect(rows.get("cmp_cbo")).toMatchObject({ dailyBudget: 5_000, lifetimeBudget: null, budgetType: "DAILY", status: "ACTIVE", workflowStatus: "ACTIVE" });
    expect(rows.get("cmp_abo")).toMatchObject({ dailyBudget: 5_000, budgetType: "DAILY", status: "ACTIVE" });
    expect(rows.get("cmp_life")).toMatchObject({ dailyBudget: null, lifetimeBudget: 100_000, budgetType: "LIFETIME", status: "PAUSED" });
    // Yarım kalan Admedic yayını (APPROVED) senkronla değişmez.
    expect(rows.get("cmp_partial")).toMatchObject({ id: partial.id, workflowStatus: "APPROVED", status: "PAUSED", dailyBudget: 1_000 });
    expect(listAdSets).toHaveBeenCalledTimes(1);

    round = 2;
    await syncInsights(meta, await workspaceWithAccounts());
    rows = await byMeta();
    expect(rows.get("cmp_cbo")).toMatchObject({ dailyBudget: 7_000, status: "PAUSED" });
    expect(rows.get("cmp_life")).toMatchObject({ status: "ARCHIVED" });
    expect(rows.get("cmp_partial")).toMatchObject({ status: "PAUSED", dailyBudget: 1_000 });
    // Mevcut kampanyalar için ad set listesi yeniden çekilmez.
    expect(listAdSets).toHaveBeenCalledTimes(1);
    await prisma.campaign.deleteMany({ where: { adAccountId: budgetAccountId } });
    await prisma.adAccount.delete({ where: { id: budgetAccountId } });
  });

  it("reklam incelemesi: vadesi gelen kampanyayı okur, yeni redde uyarı üretir, aralık dolmadan tekrar okumaz; Meta hatası turu durdurmaz", async () => {
    const reviewAccountId = (await prisma.adAccount.create({
      data: { orgId, workspaceId, connectionId, name: "İnceleme", currency: "EUR", metaAccountId: `act_review${suffix}` },
    })).id;
    const mkCampaign = async (name: string, workflowStatus: "ACTIVE" | "PUBLISHED_PAUSED", adIds: string[], checkedAt: Date | null) => {
      const campaign = await prisma.campaign.create({ data: {
        adAccountId: reviewAccountId, workspaceId, name, metaCampaignId: `cmp_${name}_${suffix}`, workflowStatus,
        status: workflowStatus === "ACTIVE" ? "ACTIVE" : "PAUSED", metaReviewCheckedAt: checkedAt,
      } });
      const adSet = await prisma.adSet.create({ data: { campaignId: campaign.id, workspaceId, name: "AS", metaAdSetId: `as_${name}_${suffix}` } });
      for (const metaAdId of adIds)
        await prisma.ad.create({ data: { adSetId: adSet.id, workspaceId, name: `Reklam ${metaAdId}`, metaAdId } });
      return campaign.id;
    };
    const now = new Date();
    const active = await mkCampaign("aktif", "ACTIVE", [`rej_${suffix}`, `ok_${suffix}`], null);
    // PAUSED yayınlanmış kampanya 1 saat önce kontrol edildi → 6 saatlik aralık dolmadı.
    const paused = await mkCampaign("durdurulmus", "PUBLISHED_PAUSED", [`p_${suffix}`], new Date(now.getTime() - 3_600_000));
    const broken = await mkCampaign("hatali", "ACTIVE", [`boom_${suffix}`], null);
    const calls: string[][] = [];
    const meta = {
      ...stubClient({}),
      async getAdReviews(ids: string[]) {
        calls.push(ids);
        if (ids.some((id) => id.startsWith("boom_"))) throw new MetaGraphError({ code: 17, message: "User request limit reached" });
        return ids.map((id) => ({
          id,
          effectiveStatus: id.startsWith("rej_") ? "DISAPPROVED" : "PENDING_REVIEW",
          reviewFeedbackGlobal: id.startsWith("rej_") ? { PERSONAL_HEALTH: "Sağlık iddiası" } : {},
          reviewFeedbackPlacements: {},
        }));
      },
    } as unknown as MetaClientLike;

    expect(await syncAdReviews(meta, { id: workspaceId, orgId }, now)).toBe(1);
    expect(calls.map((c) => c.length).sort()).toEqual([1, 2]); // aktif + hatalı; PAUSED kampanyanın vadesi gelmedi
    const stored = await prisma.campaign.findUniqueOrThrow({ where: { id: active } });
    expect(stored).toMatchObject({ metaReviewStatus: "DISAPPROVED", metaReviewCheckedAt: now });
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: broken } })).metaReviewCheckedAt).toBeNull();
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: paused } })).metaReviewStatus).toBeNull();
    const alert = await prisma.alert.findFirstOrThrow({ where: { workspaceId, type: "AD_DISAPPROVED" } });
    expect(alert).toMatchObject({ severity: "CRITICAL", status: "OPEN", entityType: "AD" });
    expect(alert.message).toContain("Sağlık iddiası");

    // Aralık dolmadan aktif kampanya tekrar okunmaz (yalnızca hatalı olan yeniden denenir).
    calls.length = 0;
    expect(await syncAdReviews(meta, { id: workspaceId, orgId }, new Date(now.getTime() + 60_000))).toBe(0);
    expect(calls).toHaveLength(1);
    calls.length = 0;
    expect(await syncAdReviews(meta, { id: workspaceId, orgId }, new Date(now.getTime() + REVIEW_INTERVAL_ACTIVE_MS + 60_000))).toBe(0);
    expect(calls).toHaveLength(2);
    expect(await prisma.alert.count({ where: { workspaceId, type: "AD_DISAPPROVED" } })).toBe(1);

    await prisma.alert.deleteMany({ where: { workspaceId, type: "AD_DISAPPROVED" } });
    await prisma.campaign.deleteMany({ where: { adAccountId: reviewAccountId } });
    await prisma.adAccount.delete({ where: { id: reviewAccountId } });
  });

  it("anomali uyarılarını OPEN dedup ile oluşturur", async () => {
    const campaign = await prisma.campaign.create({ data: { adAccountId: kwdAccountId, workspaceId, name: "Anomali", metaCampaignId: `anom_${suffix}` } });
    const anchor = new Date(); anchor.setUTCHours(0, 0, 0, 0);
    for (let offset = 0; offset < 14; offset++) {
      const date = new Date(anchor.getTime() - offset * 86_400_000);
      await prisma.insightSnapshot.create({ data: {
        workspaceId, adAccountId: kwdAccountId, campaignId: campaign.id, date, spend: 10_000, impressions: 5_000, clicks: 100, leads: 2,
        conversionValue: offset < 7 ? 0 : 40_000,
      } });
    }
    expect(await runAnomalyAlerts(workspaceId)).toBe(1);
    const alert = await prisma.alert.findFirstOrThrow({ where: { workspaceId, type: "ROAS_DROP", entityId: campaign.id } });
    expect(alert.severity).toBe("WARNING");
    expect(alert.status).toBe("OPEN");
    expect(alert.entityType).toBe("CAMPAIGN");
    expect(await runAnomalyAlerts(workspaceId)).toBe(0);
    await prisma.alert.update({ where: { id: alert.id }, data: { status: "RESOLVED", resolvedAt: new Date() } });
    expect(await runAnomalyAlerts(workspaceId)).toBe(1);
    expect(await prisma.alert.count({ where: { workspaceId, type: "ROAS_DROP", entityId: campaign.id } })).toBe(2);
  });

  it("haftalık rapor: alıcı yoksa atlar, tenant alıcısı ortam değişkenine üstün gelir, aynı dönem tekrar gönderilmez", async () => {
    expect(await deliverWeeklyReport(workspaceId, null)).toBe(0);
    expect(sendWeeklyReportEmail).not.toHaveBeenCalled();
    expect(await prisma.reportDelivery.count({ where: { workspaceId } })).toBe(0);

    await prisma.organization.update({ where: { id: orgId }, data: { reportRecipient: `owner-${suffix}@example.invalid` } });
    expect(await deliverWeeklyReport(workspaceId)).toBe(1);
    expect(sendWeeklyReportEmail).toHaveBeenCalledTimes(1);
    expect(sendWeeklyReportEmail.mock.calls[0]![2]).toBe(`owner-${suffix}@example.invalid`);
    const delivery = await prisma.reportDelivery.findFirstOrThrow({ where: { workspaceId } });
    expect(delivery.recipient).toBe(`owner-${suffix}@example.invalid`);
    expect(delivery.error).toBeNull();

    expect(await deliverWeeklyReport(workspaceId)).toBe(0);
    expect(sendWeeklyReportEmail).toHaveBeenCalledTimes(1);
  });
});

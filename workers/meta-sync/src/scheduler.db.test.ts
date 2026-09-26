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
import { deliverWeeklyReport, isMetaThrottleError, runAnomalyAlerts, syncInsights } from "./scheduler";

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
    const meta = stubClient({ [`kwd${suffix}`]: async () => [insightRow("2026-09-20"), insightRow("2026-09-21", { cpc: undefined, cpm: undefined })] });
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

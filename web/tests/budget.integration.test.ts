import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { prisma, type Role } from "@admedic/database";
import { tokenHash } from "../app/_lib/password";
import { SESSION_COOKIE } from "../app/_lib/auth";

const { cookieJar, updateBudget } = vi.hoisted(() => ({
  cookieJar: new Map<string, string>(), updateBudget: vi.fn(),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({
  get: (key: string) => cookieJar.has(key) ? { value: cookieJar.get(key) } : undefined,
}) }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@admedic/meta-api", () => ({ createMetaClient: () => ({ updateBudget }) }));
import { PATCH } from "../app/api/campaigns/[id]/budget/route";

describe.skipIf(process.env.STUDIO_DB_TEST !== "1")("campaign budget authorization and persistence", () => {
  const suffix = randomBytes(8).toString("hex");
  const users: string[] = [];
  const orgs: string[] = [];
  const tokens: Record<string, string> = {};
  const userByRole: Record<string, string> = {};
  let workspaceId: string;
  let accountId: string;
  let connectionId: string;
  beforeAll(async () => {
    vi.stubEnv("META_MOCK_MODE", "true");
    for (const foreign of [false, true]) {
      // monthlyAdBudgetCap minor unit (ADR-0011): 30.000,00 = 3_000_000 cent.
      const org = await prisma.organization.create({ data: {
        name: "Budget fixture", slug: `budget-${suffix}-${foreign}`, monthlyAdBudgetCap: 3_000_000,
        workspaces: { create: { name: "Budget", slug: "budget" } },
      }, include: { workspaces: true } });
      orgs.push(org.id);
      for (const role of (foreign ? ["OWNER"] : ["OWNER", "ADMIN", "MEDIA_BUYER", "VIEWER"]) as Role[]) {
        const user = await prisma.user.create({ data: { email: `${suffix}-${foreign}-${role}@example.invalid` } });
        users.push(user.id);
        await prisma.membership.create({ data: { orgId: org.id, userId: user.id, role } });
        const token = randomBytes(32).toString("hex");
        await prisma.webSession.create({ data: {
          tokenHash: tokenHash(token), userId: user.id, workspaceId: org.workspaces[0].id,
          expiresAt: new Date(Date.now() + 600_000),
        } });
        tokens[foreign ? "FOREIGN" : role] = token;
        userByRole[foreign ? "FOREIGN" : role] = user.id;
      }
      if (!foreign) {
        workspaceId = org.workspaces[0].id;
        const conn = await prisma.metaConnection.create({ data: { orgId: org.id, type: "BUSINESS_MANAGER" } });
        connectionId = conn.id;
        const account = await prisma.adAccount.create({ data: {
          orgId: org.id, workspaceId, connectionId, name: "Budget account",
        } });
        accountId = account.id;
      }
    }
  });
  beforeEach(() => { updateBudget.mockReset().mockResolvedValue({ success: true }); });
  afterAll(async () => {
    cookieJar.clear();
    await prisma.organization.deleteMany({ where: { id: { in: orgs } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    vi.unstubAllEnvs();
    await prisma.$disconnect();
  });
  // Kampanya bütçesi DB'de cent: 200,00 = 20_000 cent.
  const draft = (published = false) => prisma.campaign.create({ data: {
    adAccountId: accountId, workspaceId, name: "Budget test", dailyBudget: 20_000,
    workflowStatus: published ? "PUBLISHED_PAUSED" : "DRAFT",
    metaCampaignId: published ? `meta-${randomBytes(8).toString("hex")}` : null,
  } });
  // API girdisi major (insan) birim; sunucu cent'e çevirir.
  const change = (id: string, role: string, dailyBudget: number, origin = "http://localhost:3000") => {
    cookieJar.set(SESSION_COOKIE, tokens[role]);
    return PATCH(new Request(`http://localhost:3000/api/campaigns/${id}/budget`, {
      method: "PATCH", headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ dailyBudget, reason: "Budget review" }),
    }), { params: Promise.resolve({ id }) });
  };
  // Harcama yetkisi devri (Owner'ın verdiği yetki; uç testi spend-authority.integration.test.ts'te).
  const setSpendAuthority = (role: string, granted: boolean) =>
    prisma.membership.updateMany({ where: { orgId: orgs[0], userId: userByRole[role] }, data: { canApproveSpend: granted } });
  it("increases need Owner or delegated spend authority; decreases are open to editors; audit in cents", async () => {
    const c = await draft();
    expect((await change(c.id, "MEDIA_BUYER", 300)).status).toBe(403);
    const decreased = await change(c.id, "MEDIA_BUYER", 100);
    expect(decreased.status).toBe(200);
    expect((await decreased.json()).campaign).toMatchObject({ dailyBudgetCents: 10_000, dailyBudget: 100 });
    expect((await change(c.id, "OWNER", 300)).status).toBe(200);
    // ADMIN rolü tek başına bütçe artıramaz (spec 3.6); Owner yetki verince artırabilir, geri alınca yine 403.
    const denied = await change(c.id, "ADMIN", 400.5);
    expect(denied.status).toBe(403);
    expect((await denied.json()).error).toMatch(/Owner/);
    await setSpendAuthority("ADMIN", true);
    expect((await change(c.id, "ADMIN", 400.5)).status).toBe(200);
    await setSpendAuthority("ADMIN", false);
    expect((await change(c.id, "ADMIN", 450)).status).toBe(403);
    await setSpendAuthority("MEDIA_BUYER", true);
    expect((await change(c.id, "MEDIA_BUYER", 410)).status).toBe(200);
    await setSpendAuthority("MEDIA_BUYER", false);
    const logs = await prisma.auditLog.findMany({ where: { entityId: c.id }, orderBy: { createdAt: "asc" } });
    expect(logs).toHaveLength(4);
    expect(logs[0].before).toMatchObject({ dailyBudgetCents: 20_000 });
    expect(logs[0].after).toMatchObject({ dailyBudgetCents: 10_000, reason: "Budget review", increase: false });
    expect(logs[2].after).toMatchObject({ dailyBudgetCents: 40_050, increase: true });
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: c.id } })).dailyBudget).toBe(41_000);
    expect(updateBudget).not.toHaveBeenCalled();
  });
  it("the monthly cap counts other active campaigns of the same currency, never the campaign itself", async () => {
    const active = await prisma.campaign.create({ data: {
      adAccountId: accountId, workspaceId, name: "Aktif", dailyBudget: 50_000, status: "ACTIVE", workflowStatus: "ACTIVE",
      metaCampaignId: `meta-${randomBytes(8).toString("hex")}`,
    } });
    const c = await draft();
    // 50.000 × 30 = 1.500.000 aktif; 500 × 30 = 1.500.000 → toplam 3.000.000 = sınır (aşmıyor).
    expect((await change(c.id, "OWNER", 500)).status).toBe(200);
    const over = await change(c.id, "OWNER", 501);
    expect(over.status).toBe(422);
    expect((await over.json()).error).toMatch(/aktif kampanyalar/);
    // Aktif kampanyanın kendi artışı kendisini ikinci kez saymaz (sayılsaydı 1.500.000 + 2.997.000 > 3.000.000);
    // taslak (PAUSED) kampanyalar toplamda yer almaz.
    expect((await change(active.id, "OWNER", 999)).status).toBe(200);
    expect(updateBudget).toHaveBeenLastCalledWith({ entityType: "campaign", entityId: active.metaCampaignId, dailyBudgetCents: 99_900 }, "mock-token");
    await prisma.campaign.update({ where: { id: active.id }, data: { status: "ARCHIVED", workflowStatus: "ARCHIVED" } });
  });
  it("ABO: published budgets go to Meta ad sets proportionally and local shares follow; drafts rescale locally", async () => {
    const published = await prisma.campaign.create({ data: {
      adAccountId: accountId, workspaceId, name: "ABO yayında", dailyBudget: 20_000, workflowStatus: "PUBLISHED_PAUSED",
      metaCampaignId: `meta-${randomBytes(8).toString("hex")}`, plan: { strategy: "ABO" },
      adsets: { create: [
        { workspaceId, name: "DE", dailyBudget: 5_000, metaAdSetId: "as-meta-1" },
        { workspaceId, name: "TR", dailyBudget: 15_000, metaAdSetId: "as-meta-2" },
      ] },
    } });
    const res = await change(published.id, "OWNER", 300);
    expect(res.status).toBe(200);
    expect(updateBudget.mock.calls.map(([arg]) => arg)).toEqual([
      { entityType: "adset", entityId: "as-meta-1", dailyBudgetCents: 7_500 },
      { entityType: "adset", entityId: "as-meta-2", dailyBudgetCents: 22_500 },
    ]);
    const rows = await prisma.adSet.findMany({ where: { campaignId: published.id }, orderBy: { name: "asc" } });
    expect(rows.map((r) => r.dailyBudget)).toEqual([7_500, 22_500]);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: published.id } });
    expect(audit.after).toMatchObject({ metaLevel: "adset", dailyBudgetCents: 30_000 });

    // İkinci ad set Meta'da başarısız: ilki eski değerine geri alınır, yerel değişiklik yok.
    updateBudget.mockReset().mockResolvedValueOnce({ success: true }).mockRejectedValueOnce(new Error("x")).mockResolvedValue({ success: true });
    expect((await change(published.id, "OWNER", 250)).status).toBe(502);
    expect(updateBudget.mock.calls.at(-1)?.[0]).toEqual({ entityType: "adset", entityId: "as-meta-1", dailyBudgetCents: 7_500 });
    expect((await prisma.adSet.findMany({ where: { campaignId: published.id }, orderBy: { name: "asc" } })).map((r) => r.dailyBudget)).toEqual([7_500, 22_500]);

    updateBudget.mockReset().mockResolvedValue({ success: true });
    const local = await prisma.campaign.create({ data: {
      adAccountId: accountId, workspaceId, name: "ABO taslak", dailyBudget: 9_000, plan: { strategy: "ABO" },
      adsets: { create: [{ workspaceId, name: "A", dailyBudget: 4_500 }, { workspaceId, name: "B", dailyBudget: 4_500 }] },
    } });
    expect((await change(local.id, "MEDIA_BUYER", 60)).status).toBe(200);
    expect((await prisma.adSet.findMany({ where: { campaignId: local.id }, orderBy: { name: "asc" } })).map((r) => r.dailyBudget)).toEqual([3_000, 3_000]);
    expect(updateBudget).not.toHaveBeenCalled();
  });
  it("a half-finished Meta publish blocks budget edits until it is completed or archived", async () => {
    const c = await prisma.campaign.create({ data: {
      adAccountId: accountId, workspaceId, name: "Yarım yayın", dailyBudget: 20_000, workflowStatus: "APPROVED",
      metaCampaignId: `meta-${randomBytes(8).toString("hex")}`,
    } });
    const res = await change(c.id, "OWNER", 100);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/yarım kaldı/);
  });
  it("rejects viewer, foreign tenant, invalid input, foreign origin and over-cap budgets", async () => {
    const c = await draft();
    expect((await change(c.id, "VIEWER", 100)).status).toBe(403);
    expect((await change(c.id, "FOREIGN", 100)).status).toBe(404);
    for (const value of [0, -1, 0.001]) expect((await change(c.id, "OWNER", value)).status).toBe(400);
    expect((await change(c.id, "OWNER", 100, "https://other.invalid")).status).toBe(403);
    // 1001 × 30 gün = 3.003.000 cent > 3.000.000 cent üst sınır.
    expect((await change(c.id, "OWNER", 1001)).status).toBe(422);
    expect((await change(c.id, "OWNER", 1000)).status).toBe(200);
  });
  it("updates Meta for a published campaign with cents and persists its synchronized budget", async () => {
    const c = await draft(true);
    expect((await change(c.id, "OWNER", 300)).status).toBe(200);
    expect(updateBudget).toHaveBeenCalledWith({ entityType: "campaign", entityId: c.metaCampaignId, dailyBudgetCents: 30_000 }, "mock-token");
    const saved = await prisma.campaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(saved.dailyBudget).toBe(30_000);
    expect(saved.syncedAt).not.toBeNull();
  });
  it("keeps budget and audit unchanged on Meta exceptions and unsuccessful responses", async () => {
    const c = await draft(true);
    updateBudget.mockRejectedValueOnce(new Error("upstream secret"));
    const failed = await change(c.id, "OWNER", 300);
    expect(failed.status).toBe(502);
    expect(await failed.text()).not.toContain("upstream secret");
    updateBudget.mockResolvedValueOnce({ success: false });
    expect((await change(c.id, "OWNER", 300)).status).toBe(502);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: c.id } })).dailyBudget).toBe(20_000);
    expect(await prisma.auditLog.count({ where: { entityId: c.id } })).toBe(0);
  });
  it("rejects disconnected Meta and archived campaigns; equal budgets are idempotent", async () => {
    const c = await draft(true);
    expect((await change(c.id, "MEDIA_BUYER", 200)).status).toBe(200);
    expect(updateBudget).not.toHaveBeenCalled();
    await prisma.metaConnection.update({ where: { id: connectionId }, data: { status: "EXPIRED" } });
    expect((await change(c.id, "OWNER", 300)).status).toBe(400);
    await prisma.metaConnection.update({ where: { id: connectionId }, data: { status: "CONNECTED" } });
    await prisma.campaign.update({ where: { id: c.id }, data: { workflowStatus: "ARCHIVED" } });
    expect((await change(c.id, "OWNER", 300)).status).toBe(409);
    expect(updateBudget).not.toHaveBeenCalled();
  });
});

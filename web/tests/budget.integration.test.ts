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
  let workspaceId: string;
  let accountId: string;
  let connectionId: string;
  beforeAll(async () => {
    vi.stubEnv("META_MOCK_MODE", "true");
    for (const foreign of [false, true]) {
      const org = await prisma.organization.create({ data: {
        name: "Budget fixture", slug: `budget-${suffix}-${foreign}`, monthlyAdBudgetCap: 30_000,
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
  const draft = (published = false) => prisma.campaign.create({ data: {
    adAccountId: accountId, workspaceId, name: "Budget test", dailyBudget: 200,
    workflowStatus: published ? "PUBLISHED_PAUSED" : "DRAFT",
    metaCampaignId: published ? `meta-${randomBytes(8).toString("hex")}` : null,
  } });
  const change = (id: string, role: string, dailyBudget: number, origin = "http://localhost:3000") => {
    cookieJar.set(SESSION_COOKIE, tokens[role]);
    return PATCH(new Request(`http://localhost:3000/api/campaigns/${id}/budget`, {
      method: "PATCH", headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ dailyBudget, reason: "Budget review" }),
    }), { params: Promise.resolve({ id }) });
  };
  it("buyer can decrease but cannot increase; owner/admin can increase; audit includes before/after", async () => {
    const c = await draft();
    expect((await change(c.id, "MEDIA_BUYER", 300)).status).toBe(403);
    expect((await change(c.id, "MEDIA_BUYER", 100)).status).toBe(200);
    expect((await change(c.id, "OWNER", 300)).status).toBe(200);
    expect((await change(c.id, "ADMIN", 400)).status).toBe(200);
    const logs = await prisma.auditLog.findMany({ where: { entityId: c.id }, orderBy: { createdAt: "asc" } });
    expect(logs).toHaveLength(3);
    expect(logs[0].before).toMatchObject({ dailyBudget: 200 });
    expect(logs[0].after).toMatchObject({ dailyBudget: 100, reason: "Budget review" });
    expect(updateBudget).not.toHaveBeenCalled();
  });
  it("rejects viewer, foreign tenant, invalid input, foreign origin and over-cap budgets", async () => {
    const c = await draft();
    expect((await change(c.id, "VIEWER", 100)).status).toBe(403);
    expect((await change(c.id, "FOREIGN", 100)).status).toBe(404);
    for (const value of [0, -1, 1.5]) expect((await change(c.id, "OWNER", value)).status).toBe(400);
    expect((await change(c.id, "OWNER", 100, "https://other.invalid")).status).toBe(403);
    expect((await change(c.id, "OWNER", 1001)).status).toBe(422);
    expect((await change(c.id, "OWNER", 1000)).status).toBe(200);
  });
  it("updates Meta for a published campaign and persists its synchronized budget", async () => {
    const c = await draft(true);
    expect((await change(c.id, "OWNER", 300)).status).toBe(200);
    expect(updateBudget).toHaveBeenCalledWith({ entityType: "campaign", entityId: c.metaCampaignId, dailyBudgetCents: 30_000 }, "mock-token");
    const saved = await prisma.campaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(saved.dailyBudget).toBe(300);
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
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: c.id } })).dailyBudget).toBe(200);
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

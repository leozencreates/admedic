import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { prisma } from "@admedic/database";
import { tokenHash } from "../app/_lib/password";
import { SESSION_COOKIE } from "../app/_lib/auth";

const { cookieJar } = vi.hoisted(() => ({ cookieJar: new Map<string, string>() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (key: string) => cookieJar.has(key) ? { value: cookieJar.get(key) } : undefined,
    set: () => undefined,
    delete: (key: string) => cookieJar.delete(key),
  }),
}));
vi.mock("next/navigation", () => ({ redirect: () => { throw new Error("redirect"); } }));

import { GET as rulesGet, POST as rulesPost } from "../app/api/policy-rules/route";
import { GET as historyGet, PATCH as rulesPatch } from "../app/api/policy-rules/[key]/route";
import { POST as campaignsPost } from "../app/api/campaigns/route";
import { POST as submitPost } from "../app/api/campaigns/[id]/submit/route";

function req(url: string, method: string, bodyObj?: unknown) {
  return new Request(`http://localhost:3000${url}`, {
    method,
    headers: { origin: "http://localhost:3000", "content-type": "application/json" },
    body: bodyObj === undefined ? undefined : JSON.stringify(bodyObj),
  });
}

describe.skipIf(process.env.STUDIO_DB_TEST !== "1")("Platform Admin policy rule management", () => {
  const suffix = randomBytes(8).toString("hex");
  let orgId = "";
  let workspaceId = "";
  let userIds: string[] = [];
  let tokenAdmin = "";
  let tokenOwner = "";
  const createdKeys: string[] = [];
  const campaignIds: string[] = [];

  beforeAll(async () => {
    const admin = await prisma.user.create({ data: { email: `pa-${suffix}@example.invalid`, isPlatformAdmin: true } });
    const owner = await prisma.user.create({ data: { email: `o-${suffix}@example.invalid` } });
    userIds = [admin.id, owner.id];
    const org = await prisma.organization.create({
      data: {
        name: "Policy fixture", slug: `pol-${suffix}`,
        members: {
          create: [
            { userId: admin.id, role: "OWNER" },
            { userId: owner.id, role: "OWNER" },
          ],
        },
        workspaces: { create: { name: "Ws", slug: "pol" } },
      },
      include: { workspaces: true },
    });
    orgId = org.id;
    workspaceId = org.workspaces[0].id;
    await prisma.adAccount.create({ data: { orgId, workspaceId, name: "Policy account" } });
    const session = async (userId: string) => {
      const token = randomBytes(32).toString("hex");
      await prisma.webSession.create({ data: { tokenHash: tokenHash(token), userId, workspaceId, expiresAt: new Date(Date.now() + 600_000) } });
      return token;
    };
    tokenAdmin = await session(admin.id);
    tokenOwner = await session(owner.id);
  });

  afterAll(async () => {
    cookieJar.clear();
    await prisma.campaign.deleteMany({ where: { id: { in: campaignIds } } });
    await prisma.policyRule.deleteMany({ where: { key: { in: [...createdKeys, "vip-claim"] } } });
    await prisma.auditLog.deleteMany({ where: { orgId } });
    await prisma.adAccount.deleteMany({ where: { orgId } });
    await prisma.organization.deleteMany({ where: { id: orgId } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    vi.unstubAllEnvs();
    await prisma.$disconnect();
  });

  it("restricts global rule management to Platform Admin", async () => {
    cookieJar.set(SESSION_COOKIE, tokenOwner);
    expect((await rulesGet()).status).toBe(403);
    expect((await rulesPost(req("/api/policy-rules", "POST", { key: "x", matcher: "PHRASES_V1", phrases: ["a"], risk: "MEDIUM", reason: "r", suggestion: "s" }))).status).toBe(403);
    cookieJar.set(SESSION_COOKIE, tokenAdmin);
    expect((await rulesGet()).status).toBe(200);
  });

  it("creates a new phrase rule only when the key is inactive; active keys conflict", async () => {
    cookieJar.set(SESSION_COOKIE, tokenAdmin);
    const created = await rulesPost(req("/api/policy-rules", "POST", {
      key: "vip-claim", matcher: "PHRASES_V1", phrases: ["%100 garanti", "kesin çözüm"],
      risk: "HIGH", reason: "Sert iddialar", suggestion: "Süreci anlatın",
    }));
    expect(created.status).toBe(200);
    const again = await rulesPost(req("/api/policy-rules", "POST", {
      key: "vip-claim", matcher: "PHRASES_V1", phrases: ["x"], risk: "HIGH", reason: "r", suggestion: "s",
    }));
    expect(again.status).toBe(409);
    createdKeys.push("vip-claim");
  });

  it("persists immutable history on versioned updates and edits cannot skip version", async () => {
    cookieJar.set(SESSION_COOKIE, tokenAdmin);
    const hist = await historyGet(req(`/api/policy-rules/vip-claim`, "GET"), { params: Promise.resolve({ key: "vip-claim" }) });
    const rules = (await hist.json()).rules as { version: number }[];
    const newest = Math.max(...rules.map((r) => r.version));
    expect(rules.length).toBe(1);
    const patch = await rulesPatch(req("/api/policy-rules/vip-claim", "PATCH", {
      expectedPreviousVersion: newest, intendedVersion: newest, active: false,
    }), { params: Promise.resolve({ key: "vip-claim" }) });
    expect(patch.status).toBe(200);
    const stale = await rulesPatch(req("/api/policy-rules/vip-claim", "PATCH", {
      expectedPreviousVersion: newest, intendedVersion: newest, active: true,
    }), { params: Promise.resolve({ key: "vip-claim" }) });
    expect(stale.status).toBe(409);
    const reopen = await rulesPatch(req("/api/policy-rules/vip-claim", "PATCH", {
      expectedPreviousVersion: newest + 1, intendedVersion: newest + 1, active: true,
    }), { params: Promise.resolve({ key: "vip-claim" }) });
    expect(reopen.status).toBe(200);
    const hist2 = (await (await historyGet(req(`/api/policy-rules/vip-claim`, "GET"), { params: Promise.resolve({ key: "vip-claim" }) })).json()).rules;
    expect(hist2).toHaveLength(3);
  });

  it("enforces a disabled revision and does not resurrect older active versions", async () => {
    cookieJar.set(SESSION_COOKIE, tokenOwner);
    const draft = await campaignsPost(req("/api/campaigns", "POST", { name: "Kesin çözüm vadediyoruz", budget: 100 }));
    expect(draft.status).toBe(200);
    const body = await draft.json();
    campaignIds.push(body.campaign.id);
    const highRisk = body.campaign.policyRisk;
    expect(highRisk).toBe("HIGH");

    cookieJar.set(SESSION_COOKIE, tokenAdmin);
    const hist = (await (await historyGet(req(`/api/policy-rules/vip-claim`, "GET"), { params: Promise.resolve({ key: "vip-claim" }) })).json()).rules;
    const newest = Math.max(...hist.map((r: { version: number }) => r.version));
    await rulesPatch(req("/api/policy-rules/vip-claim", "PATCH", {
      expectedPreviousVersion: newest, intendedVersion: newest, active: false,
    }), { params: Promise.resolve({ key: "vip-claim" }) });

    cookieJar.set(SESSION_COOKIE, tokenOwner);
    const draft2 = await campaignsPost(req("/api/campaigns", "POST", { name: "Kesin çözüm vadediyoruz", budget: 100 }));
    const cleanBody = await draft2.json();
    expect(cleanBody.campaign.policyRisk).not.toBe("HIGH");
    campaignIds.push(cleanBody.campaign.id);
  });

  it("audits every change with before/after and keeps rules effective for submit gate", async () => {
    cookieJar.set(SESSION_COOKIE, tokenOwner);
    const draft = await campaignsPost(req("/api/campaigns", "POST", { name: "Kesin sonuç garantisi", budget: 100 }));
    const body = await draft.json();
    campaignIds.push(body.campaign.id);
    const submit = await submitPost(req(`/api/campaigns/${body.campaign.id}/submit`, "POST"), { params: Promise.resolve({ id: body.campaign.id }) });
    expect(submit.status).toBe(422);
    const audits = await prisma.auditLog.count({ where: { orgId, action: "POLICY_RULE_UPDATED" } });
    expect(audits).toBeGreaterThan(0);
  });
});
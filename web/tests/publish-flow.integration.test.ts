import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { prisma } from "@admedic/database";
import { tokenHash } from "../app/_lib/password";
import { SESSION_COOKIE } from "../app/_lib/auth";

const { cookieJar } = vi.hoisted(() => ({
  cookieJar: new Map<string, string>(),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (key: string) =>
      cookieJar.has(key) ? { value: cookieJar.get(key) } : undefined,
    set: (key: string, value: string) => cookieJar.set(key, value),
    delete: (key: string) => cookieJar.delete(key),
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: () => {
    throw new Error("redirect");
  },
}));

import { POST as campaignsPost, GET as campaignsGet } from "../app/api/campaigns/route";
import { POST as submitPost } from "../app/api/campaigns/[id]/submit/route";
import { POST as approvePost } from "../app/api/campaigns/[id]/approve/route";
import { POST as rejectPost } from "../app/api/campaigns/[id]/reject/route";
import { POST as publishPost } from "../app/api/campaigns/[id]/publish/route";
import { POST as plannerPost } from "../app/api/campaign-planner/route";

function req(url: string, method: string, bodyObj?: unknown) {
  return new Request(`http://localhost:3000${url}`, {
    method,
    headers: {
      origin: "http://localhost:3000",
      "content-type": "application/json",
    },
    body: bodyObj === undefined ? undefined : JSON.stringify(bodyObj),
  });
}

describe.skipIf(process.env.STUDIO_DB_TEST !== "1")(
  "campaign workflow: plan → draft → submit → approve/reject → publish (PAUSED) → activate/pause/archive",
  () => {
    const suffix = randomBytes(8).toString("hex");
    let orgIds: string[] = [];
    let workspaceIds: string[] = [];
    let userIds: string[] = [];
    let tokenOwner = "";
    let tokenBuyer = "";
    let tokenForeign = "";
    const campaignIds: string[] = [];

    beforeAll(async () => {
      vi.stubEnv("ENCRYPTION_KEY", "82da20c19f1765f384e674dc19d7c4ecdc7dd6475527fa1cf5465f43092e21cf");
      const mkUser = async () =>
        prisma.user.create({ data: { email: `${randomBytes(4).toString("hex")}-${suffix}@example.invalid` } });
      const owner = await mkUser();
      const buyer = await mkUser();
      const foreign = await mkUser();
      userIds.push(owner.id, buyer.id, foreign.id);

      const org1 = await prisma.organization.create({
        data: {
          name: "Publish fixture A",
          slug: `pubfix-a-${suffix}`,
          monthlyAdBudgetCap: 10_000,
          members: {
            create: [
              { userId: owner.id, role: "OWNER" },
              { userId: buyer.id, role: "MEDIA_BUYER" },
            ],
          },
          workspaces: { create: { name: "Ws", slug: "pub-a" } },
        },
        include: { workspaces: true },
      });
      const org2 = await prisma.organization.create({
        data: {
          name: "Publish fixture B",
          slug: `pubfix-b-${suffix}`,
          members: { create: { userId: foreign.id, role: "OWNER" } },
          workspaces: { create: { name: "Ws", slug: "pub-b" } },
        },
        include: { workspaces: true },
      });
      orgIds.push(org1.id, org2.id);
      const ws1 = org1.workspaces[0].id;
      const ws2 = org2.workspaces[0].id;
      workspaceIds.push(ws1, ws2);

      const conn = await prisma.metaConnection.create({
        data: {
          orgId: org1.id,
          type: "BUSINESS_MANAGER",
          status: "CONNECTED",
          metaAccountId: "act_fixture_001",
        },
      });
      await prisma.adAccount.create({
        data: {
          orgId: org1.id,
          workspaceId: ws1,
          connectionId: conn.id,
          name: "Publish ad account",
          status: "ACTIVE",
        },
      });

      const session = async (u: string, ws: string) => {
        const t = randomBytes(32).toString("hex");
        await prisma.webSession.create({
          data: {
            tokenHash: tokenHash(t),
            userId: u,
            workspaceId: ws,
            expiresAt: new Date(Date.now() + 60_000),
          },
        });
        return t;
      };
      tokenOwner = await session(owner.id, ws1);
      tokenBuyer = await session(buyer.id, ws1);
      tokenForeign = await session(foreign.id, ws2);
    });

    afterAll(async () => {
      cookieJar.clear();
      await prisma.campaign.deleteMany({ where: { id: { in: campaignIds } } });
      await prisma.auditLog.deleteMany({ where: { orgId: { in: orgIds } } });
      await prisma.adAccount.deleteMany({ where: { orgId: { in: orgIds } } });
      await prisma.metaConnection.deleteMany({ where: { orgId: { in: orgIds } } });
      await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      vi.unstubAllEnvs();
      await prisma.$disconnect();
    });

    async function makeDraft(name: string, budget = 200) {
      cookieJar.set(SESSION_COOKIE, tokenOwner);
      const res = await campaignsPost(req("/api/campaigns", "POST", { name, budget }));
      const json = await res.json();
      campaignIds.push(json.campaign.id);
      return { res, campaign: json.campaign };
    }

    async function submit(id: string) {
      return submitPost(req(`/api/campaigns/${id}/submit`, "POST"), { params: Promise.resolve({ id }) });
    }
    async function approve(id: string) {
      return approvePost(req(`/api/campaigns/${id}/approve`, "POST"), { params: Promise.resolve({ id }) });
    }
    async function reject(id: string, reason: string) {
      return rejectPost(req(`/api/campaigns/${id}/reject`, "POST", { reason }), { params: Promise.resolve({ id }) });
    }
    async function publish(id: string, action: string) {
      return publishPost(req(`/api/campaigns/${id}/publish`, "POST", { action }), { params: Promise.resolve({ id }) });
    }

    it("planner blocks under-18 targeting and over-cap budgets", async () => {
      cookieJar.set(SESSION_COOKIE, tokenOwner);
      const under18 = await plannerPost(
        req("/api/campaign-planner", "POST", {
          objective: "MAX_CONVERSIONS",
          dailyBudgetCents: 20_000,
          markets: ["TR"],
          ageMin: 16,
        }),
      );
      expect(under18.status).toBe(200);
      const plan = (await under18.json()).plan;
      expect(plan.blocked).toBe(true);
      expect(plan.blockingReasons.join()).toMatch(/18 yaş/);

      const overCap = await plannerPost(
        req("/api/campaign-planner", "POST", {
          objective: "MAX_CONVERSIONS",
          dailyBudgetCents: 400_000, // 400*30 = 12000 > 10000 cap
          markets: ["DE"],
        }),
      );
      const plan2 = (await overCap.json()).plan;
      expect(plan2.blocked).toBe(true);
      expect(plan2.blockingReasons.join()).toMatch(/üst sınır/);
    });

    it("draft creation applies policy and budget cap", async () => {
      const { res, campaign } = await makeDraft("Yaz Kampanyası", 300);
      expect(res.status).toBe(200);
      expect(campaign.workflowStatus).toBe("DRAFT");
      expect(campaign.status).toBe("PAUSED");
      expect(["LOW", "MEDIUM", "HIGH"]).toContain(campaign.policyRisk);

      const over = await campaignsPost(
        req("/api/campaigns", "POST", { name: "Çok Uzun", budget: 400 }),
      );
      expect(over.status).toBe(422);
    });

    it("cannot publish before approval", async () => {
      const { campaign } = await makeDraft("Onay Bekleyen");
      const res = await publish(campaign.id, "PUBLISH");
      expect(res.status).toBe(409);
    });

    it("rejects high-risk draft at submit, allows normal draft through approve", async () => {
      const risky = await makeDraft("Kesin sonuç garantisi");
      const submitRisky = await submit(risky.campaign.id);
      expect(submitRisky.status).toBe(422);

      const draft = await makeDraft("Varyant Rotasyonu", 250);
      const submitted = await submit(draft.campaign.id);
      expect(submitted.status).toBe(200);
      const submitAgain = await submit(draft.campaign.id);
      expect(submitAgain.status).toBe(409);

      cookieJar.set(SESSION_COOKIE, tokenBuyer);
      const buyerApprove = await approve(draft.campaign.id);
      expect(buyerApprove.status).toBe(403);
      cookieJar.set(SESSION_COOKIE, tokenOwner);
      const approved = await approve(draft.campaign.id);
      expect(approved.status).toBe(200);
      const approveAgain = await approve(draft.campaign.id);
      expect(approveAgain.status).toBe(409);
    });

    it("reject returns campaign to resubmittable state", async () => {
      const draft = await makeDraft("Yeniden Yazılacak", 150);
      const id = draft.campaign.id;
      await submit(id);
      const rej = await reject(id, "Hedefleme netleştirilmeli.");
      expect(rej.status).toBe(200);
      const rejected = await campaignsGet();
      const found = (await rejected.json()).campaigns.find((c: { id: string }) => c.id === id);
      expect(found.workflowStatus).toBe("REJECTED");
      expect(found.rejectionReason).toContain("Hedefleme");
      const resubmit = await submit(id);
      expect(resubmit.status).toBe(200);
    });

    it("publish creates PAUSED campaign in Meta, then activations are role-gated", async () => {
      const draft = await makeDraft("Canlıya Hazır", 200);
      const id = draft.campaign.id;
      await submit(id);
      await approve(id);

      const pub = await publish(id, "PUBLISH");
      expect(pub.status).toBe(200);
      const pubJson = await pub.json();
      expect(pubJson.campaign.workflowStatus).toBe("PUBLISHED_PAUSED");
      expect(pubJson.campaign.status).toBe("PAUSED");
      expect(pubJson.campaign.metaCampaignId).toMatch(/^cmp_mock_pub_\d+$/);

      const pubAgain = await publish(id, "PUBLISH");
      expect(pubAgain.status).toBe(409);

      cookieJar.set(SESSION_COOKIE, tokenBuyer);
      const buyerActivate = await publish(id, "ACTIVATE");
      expect(buyerActivate.status).toBe(403);
      cookieJar.set(SESSION_COOKIE, tokenOwner);
      const active = await publish(id, "ACTIVATE");
      expect(active.status).toBe(200);
      expect((await active.json()).campaign.workflowStatus).toBe("ACTIVE");

      const pause = await publish(id, "PAUSE");
      expect((await pause.json()).campaign.workflowStatus).toBe("PUBLISHED_PAUSED");

      const archive = await publish(id, "ARCHIVE");
      expect((await archive.json()).campaign.workflowStatus).toBe("ARCHIVED");
    });

    it("isolates workflow access across tenants", async () => {
      const mine = await makeDraft("Görünmez", 100);
      cookieJar.set(SESSION_COOKIE, tokenForeign);
      const res = await submit(mine.campaign.id);
      expect(res.status).toBe(404);
    });
  },
);
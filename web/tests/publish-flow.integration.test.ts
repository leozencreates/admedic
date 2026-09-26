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
    const policyRuleKeys: string[] = [];
    const clinicIds: string[] = [];

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
          // minor unit (ADR-0011): 10.000,00 EUR = 1_000_000 cent
          monthlyAdBudgetCap: 1_000_000,
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
      await prisma.policyRule.deleteMany({ where: { key: { in: policyRuleKeys } } });
      await prisma.clinicProfile.deleteMany({ where: { id: { in: clinicIds } } });
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

      const inverted = await plannerPost(
        req("/api/campaign-planner", "POST", {
          objective: "MAX_CONVERSIONS",
          dailyBudgetCents: 20_000,
          markets: ["TR"],
          ageMin: 45,
          ageMax: 30,
        }),
      );
      expect(inverted.status).toBe(200);
      expect((await inverted.json()).plan.blockingReasons.join()).toMatch(/Alt yaş sınırı/);

      const overCap = await plannerPost(
        req("/api/campaign-planner", "POST", {
          objective: "MAX_CONVERSIONS",
          dailyBudgetCents: 400_000, // 400.000 × 30 = 12.000.000 cent > 1.000.000 cent cap
          markets: ["DE"],
        }),
      );
      const plan2 = (await overCap.json()).plan;
      expect(plan2.blocked).toBe(true);
      expect(plan2.blockingReasons.join()).toMatch(/üst sınır/);
    });

    it("planner accepts long market keys, maps languages per market and explains each recommendation", async () => {
      cookieJar.set(SESSION_COOKIE, tokenOwner);
      const res = await plannerPost(
        req("/api/campaign-planner", "POST", {
          objective: "MAX_CONVERSIONS",
          dailyBudgetCents: 30_000,
          markets: ["GULF", "NETHERLANDS", "DE", "POLAND"],
          conversionMethod: "instant_form",
          strategy: "ABO",
        }),
      );
      expect(res.status).toBe(200);
      const plan = (await res.json()).plan;
      expect(plan.blocked).toBe(false);
      expect(plan.currency).toBe("EUR");
      expect(plan.adSets).toHaveLength(3);
      expect(plan.adSets.map((a: { market: string }) => a.market)).toEqual(["GULF", "NETHERLANDS", "DE"]);
      expect(plan.adSets[0].targeting).toMatchObject({
        geo_locations: { countries: ["AE", "SA", "QA", "KW", "BH", "OM"] },
        locales: ["AR", "EN"],
        age_min: 18,
        age_max: 54,
      });
      expect(plan.adSets[2].targeting.locales).toEqual(["DE", "TR"]);
      expect(plan.adSets.map((a: { dailyBudgetCents: number }) => a.dailyBudgetCents)).toEqual([10_000, 10_000, 10_000]);
      expect(plan.testPlan).toMatchObject({ creativeVariations: 3, decisionMetric: expect.stringMatching(/CPL/) });
      expect(plan.structure).toMatch(/1 kontrol \+ 2 varyant/);
      for (const key of ["objective", "targeting", "conversionMethod", "testPlan", "strategy"])
        expect(typeof plan.reasons[key]).toBe("string");
      expect(plan.reasons.conversionMethod).toMatch(/Instant Form/);
    });

    it("draft creation applies policy and budget cap in cents", async () => {
      const { res, campaign } = await makeDraft("Yaz Kampanyası", 300);
      expect(res.status).toBe(200);
      expect(campaign.workflowStatus).toBe("DRAFT");
      expect(campaign.status).toBe("PAUSED");
      expect(campaign).toMatchObject({ budgetCents: 30_000, budget: 300, currency: "EUR" });
      expect(["LOW", "MEDIUM", "HIGH"]).toContain(campaign.policyRisk);
      const stored = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
      expect(stored.dailyBudget).toBe(30_000);

      const over = await campaignsPost(
        req("/api/campaigns", "POST", { name: "Çok Uzun", budget: 400 }), // 40.000 × 30 > 1.000.000
      );
      expect(over.status).toBe(422);

      const listed = await campaignsGet();
      const mine = (await listed.json()).campaigns.find((c: { id: string }) => c.id === campaign.id);
      expect(mine).toMatchObject({ budgetCents: 30_000, dailyBudget: 30_000, currency: "EUR" });
    });

    it("draft with a plan creates one ad set per market with cent budgets", async () => {
      cookieJar.set(SESSION_COOKIE, tokenOwner);
      const res = await campaignsPost(
        req("/api/campaigns", "POST", {
          name: "Pazar Bazlı",
          budget: 90,
          markets: ["DE", "GB"],
          strategy: "ABO",
          conversionMethod: "instant_form",
        }),
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      campaignIds.push(json.campaign.id);
      expect(json.campaign.adSets).toBe(2);
      const adSets = await prisma.adSet.findMany({ where: { campaignId: json.campaign.id }, orderBy: { name: "asc" } });
      expect(adSets.map((a) => a.dailyBudget).sort()).toEqual([4500, 4500]);
      expect(adSets.every((a) => a.status === "PAUSED" && a.bidStrategy === "ABO")).toBe(true);
      const de = adSets.find((a) => (a.targeting as { market?: string }).market === "DE");
      expect(de?.targeting).toMatchObject({ geo_locations: { countries: ["DE"] }, locales: ["DE", "TR"], conversionMethod: "instant_form" });
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

      const actions = (await prisma.auditLog.findMany({ where: { entityId: id }, orderBy: { createdAt: "asc" } })).map((l) => l.action);
      expect(actions).toEqual([
        "CAMPAIGN_CREATED", "CAMPAIGN_SUBMITTED", "CAMPAIGN_APPROVED",
        "CAMPAIGN_PUBLISHED", "CAMPAIGN_ACTIVATED", "CAMPAIGN_PAUSED", "CAMPAIGN_ARCHIVED",
      ]);
      const stored = await prisma.campaign.findUniqueOrThrow({ where: { id } });
      expect(stored.metaRejectionReason).toBeNull();
    });

    it("rechecks the fresh policy rule snapshot and clinic banned phrases at submit/approve", async () => {
      cookieJar.set(SESSION_COOKIE, tokenOwner);
      const phrase = `fixturephrase${suffix}`;
      const ruleKey = `fixture-rule-${suffix}`;
      policyRuleKeys.push(ruleKey);
      const draft = await makeDraft(`Kampanya ${phrase}`, 100);
      expect(draft.campaign.policyRisk).toBe("LOW");
      // Kural yayınlandıktan hemen sonra (önbellek yok) submit engellenir.
      await prisma.policyRule.create({
        data: { key: ruleKey, version: 1, matcher: "PHRASES_V1", phrases: [phrase], risk: "HIGH", reason: "Fixture yasak", suggestion: "Kaldırın", active: true },
      });
      expect((await submit(draft.campaign.id)).status).toBe(422);
      // En yüksek sürüm pasifse kural devre dışı; submit geçer.
      await prisma.policyRule.create({
        data: { key: ruleKey, version: 2, matcher: "PHRASES_V1", phrases: [phrase], risk: "HIGH", reason: "Fixture yasak", suggestion: "Kaldırın", active: false },
      });
      expect((await submit(draft.campaign.id)).status).toBe(200);

      // Klinik yasaklı ifadesi orta risk üretir: onay uyarıyla geçer, uyarı yanıt + audit'te.
      const clinic = await prisma.clinicProfile.create({
        data: { workspaceId: workspaceIds[0], name: "Fixture Klinik", slug: `fixture-${suffix}`, brandBannedPhrases: [phrase] },
      });
      clinicIds.push(clinic.id);
      const approved = await approve(draft.campaign.id);
      expect(approved.status).toBe(200);
      const approvedJson = await approved.json();
      expect(approvedJson.campaign.policyRisk).toBe("MEDIUM");
      expect(approvedJson.campaign.policyWarning).toMatch(/Klinik/);
      const audit = await prisma.auditLog.findFirst({ where: { entityId: draft.campaign.id, action: "CAMPAIGN_APPROVED" } });
      expect(audit?.after).toMatchObject({ policyWarning: expect.stringMatching(/Klinik/) });
    });

    it("isolates workflow access across tenants", async () => {
      const mine = await makeDraft("Görünmez", 100);
      cookieJar.set(SESSION_COOKIE, tokenForeign);
      const res = await submit(mine.campaign.id);
      expect(res.status).toBe(404);
    });
  },
);
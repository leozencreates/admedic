import { beforeAll, afterAll, afterEach, describe, it, expect, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { prisma } from "@admedic/database";
import { MockMetaClient, mockMetaFailures } from "@admedic/meta-api";
import { tokenHash } from "../app/_lib/password";
import { SESSION_COOKIE, type Actor } from "../app/_lib/auth";

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
import { PUT as contentPut } from "../app/api/campaigns/[id]/content/route";
import { POST as imagePost } from "../app/api/campaigns/[id]/image/route";
import { PUT as spendAuthorityPut } from "../app/api/org/members/[userId]/spend-authority/route";
import { POST as plannerPost } from "../app/api/campaign-planner/route";
import { publishCampaign } from "../app/_lib/campaign-publish";

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

/** Geçerli PNG başlığı (IHDR) — içerik doğrulaması yalnızca imza ve boyut okur. */
function pngBase64(width = 1200, height = 1200): string {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf.toString("base64");
}

/** Stüdyo taslağı içeriği (DraftSchema): tek değişkenli iki varyant + Instant Form soruları. */
function draftContent(language: string, tag: string) {
  return {
    clinic: "Fixture Klinik",
    service: "Saç ekimi",
    market: "Almanya",
    language,
    budget: 100,
    duration: 14,
    variants: [
      { headline: `${tag} başlık A`, text: `${tag} ortak metin`, description: `${tag} açıklama`, cta: "SIGN_UP" },
      { headline: `${tag} başlık B`, text: `${tag} ortak metin`, description: `${tag} açıklama`, cta: "SIGN_UP" },
    ],
    instantForm: { questions: [`${tag} hangi ay gelmeyi düşünüyorsunuz?`] },
    whatsapp: { welcome: `${tag} merhaba` },
  };
}

type Body = Record<string, string | number>;
const json = (body: Body, key: string) => JSON.parse(String(body[key])) as Record<string, unknown>;

describe.skipIf(process.env.STUDIO_DB_TEST !== "1")(
  "campaign workflow: plan → draft → content/image → submit → approve/reject → full PAUSED publish → activate/pause/archive",
  () => {
    const suffix = randomBytes(8).toString("hex");
    const orgIds: string[] = [];
    const workspaceIds: string[] = [];
    const userIds: string[] = [];
    let ownerId = "";
    let buyerId = "";
    let tokenOwner = "";
    let tokenBuyer = "";
    let tokenAdmin = "";
    let tokenForeign = "";
    const drafts: Record<string, string> = {};
    const campaignIds: string[] = [];
    const policyRuleKeys: string[] = [];
    const clinicIds: string[] = [];

    beforeAll(async () => {
      vi.stubEnv("ENCRYPTION_KEY", randomBytes(32).toString("hex")); // test başına rastgele anahtar (gerçek anahtar repoya girmez)
      const mkUser = async () =>
        prisma.user.create({ data: { email: `${randomBytes(4).toString("hex")}-${suffix}@example.invalid` } });
      const owner = await mkUser();
      const buyer = await mkUser();
      const admin = await mkUser();
      const foreign = await mkUser();
      userIds.push(owner.id, buyer.id, admin.id, foreign.id);
      ownerId = owner.id;
      buyerId = buyer.id;

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
              { userId: admin.id, role: "ADMIN" },
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

      const mkDraft = async (key: string, ws: string, language: string, status: "APPROVED" | "DRAFT" = "APPROVED") => {
        const row = await prisma.studioDraft.create({
          data: {
            workspaceId: ws,
            name: `Taslak ${key}`,
            content: draftContent(language, key),
            policy: { version: 1, risk: "LOW", findings: [] },
            status,
          },
        });
        drafts[key] = row.id;
      };
      await mkDraft("DE", ws1, "DE");
      await mkDraft("TR", ws1, "TR");
      await mkDraft("EN", ws1, "EN");
      await mkDraft("PENDING", ws1, "DE", "DRAFT");
      await mkDraft("FOREIGN", ws2, "DE");

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
      tokenAdmin = await session(admin.id, ws1);
      tokenForeign = await session(foreign.id, ws2);
    });

    afterEach(() => {
      mockMetaFailures.reset();
      vi.restoreAllMocks();
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

    const ownerActor = (): Actor => ({ userId: ownerId, workspaceId: workspaceIds[0]!, orgId: orgIds[0]!, role: "OWNER", workspaceName: "Ws" });

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
    async function attach(id: string, body: unknown) {
      return contentPut(req(`/api/campaigns/${id}/content`, "PUT", body), { params: Promise.resolve({ id }) });
    }
    async function upload(id: string, body: unknown) {
      return imagePost(req(`/api/campaigns/${id}/image`, "POST", body), { params: Promise.resolve({ id }) });
    }
    async function grant(userId: string, granted: boolean) {
      return spendAuthorityPut(req(`/api/org/members/${userId}/spend-authority`, "PUT", { granted }), { params: Promise.resolve({ userId }) });
    }

    /** Planlı kampanyayı içerik + görselle hazırlayıp onaylar (OWNER). */
    async function approvedCampaign(input: Record<string, unknown>, draftKeys: string[], landingUrl?: string) {
      cookieJar.set(SESSION_COOKIE, tokenOwner);
      await prisma.organization.update({ where: { id: orgIds[0] }, data: { privacyPolicyUrl: "https://klinik.example/gizlilik" } });
      const res = await campaignsPost(req("/api/campaigns", "POST", input));
      expect(res.status).toBe(200);
      const id = (await res.json()).campaign.id as string;
      campaignIds.push(id);
      expect((await attach(id, { draftIds: draftKeys.map((k) => drafts[k]), ...(landingUrl ? { landingUrl } : {}) })).status).toBe(200);
      expect((await upload(id, { filename: "gorsel.png", dataBase64: pngBase64() })).status).toBe(200);
      expect((await submit(id)).status).toBe(200);
      expect((await approve(id)).status).toBe(200);
      return id;
    }

    function spyMeta() {
      const proto = MockMetaClient.prototype;
      return {
        createCampaign: vi.spyOn(proto, "createCampaign"),
        createAdSet: vi.spyOn(proto, "createAdSet"),
        createLeadForm: vi.spyOn(proto, "createLeadForm"),
        createAdCreative: vi.spyOn(proto, "createAdCreative"),
        createAd: vi.spyOn(proto, "createAd"),
        searchAdLocales: vi.spyOn(proto, "searchAdLocales"),
        setStatus: vi.spyOn(proto, "setStatus"),
      };
    }

    it("planner blocks under-18 targeting, over-cap budgets and unpublishable objective/method pairs", async () => {
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

      const unpublishable = await plannerPost(
        req("/api/campaign-planner", "POST", {
          objective: "MAX_ROAS",
          dailyBudgetCents: 20_000,
          markets: ["DE"],
          conversionMethod: "instant_form",
        }),
      );
      const plan3 = (await unpublishable.json()).plan;
      expect(plan3.blocked).toBe(true);
      expect(plan3.blockingReasons.join()).toMatch(/Anında Form/);
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
      expect(plan.monthlyCommittedCents).toBe(0);
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
      expect(plan.reasons.conversionMethod).toMatch(/Anında Form/);
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
      expect(mine).toMatchObject({ budgetCents: 30_000, dailyBudget: 30_000, currency: "EUR", content: null, readiness: null });
      expect(mine.publish).toMatchObject({ status: "NOT_STARTED", campaignCreated: false });
    });

    it("draft with a plan creates one ad set per market with cent budgets", async () => {
      cookieJar.set(SESSION_COOKIE, tokenOwner);
      const res = await campaignsPost(
        req("/api/campaigns", "POST", {
          name: "Pazar Bazlı",
          objective: "MAX_CONVERSIONS",
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
      // Plansız (eski) kampanya Meta'ya eksiksiz kurulamaz: yayın açık gerekçeyle reddedilir.
      const legacy = await publish(draft.campaign.id, "PUBLISH");
      expect(legacy.status).toBe(422);
      expect((await legacy.json()).error).toMatch(/planlayıcı/);
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

    it("full PAUSED publish: content, image and privacy policy gate submit; Meta gets campaign → ad sets → forms → creatives → ads; only spend authority activates", async () => {
      cookieJar.set(SESSION_COOKIE, tokenOwner);
      const created = await campaignsPost(
        req("/api/campaigns", "POST", {
          name: `Tam Yayın ${suffix}`,
          objective: "MAX_CONVERSIONS",
          budget: 200,
          markets: ["DE"],
          strategy: "ABO",
          conversionMethod: "instant_form",
        }),
      );
      expect(created.status).toBe(200);
      const id = (await created.json()).campaign.id as string;
      campaignIds.push(id);

      const noContent = await submit(id);
      expect(noContent.status).toBe(422);
      expect((await noContent.json()).error).toMatch(/içeriği bağlanmadı/);

      // Yalnızca aynı çalışma alanındaki onaylı taslaklar bağlanır.
      expect((await attach(id, { draftIds: [drafts.PENDING] })).status).toBe(409);
      expect((await attach(id, { draftIds: [drafts.FOREIGN] })).status).toBe(404);
      const attached = await attach(id, { draftIds: [drafts.DE, drafts.TR] });
      expect(attached.status).toBe(200);
      const attachedJson = await attached.json();
      expect(attachedJson.campaign.content.languages).toEqual(["DE", "TR"]);
      expect(attachedJson.campaign.readiness.reasons.join()).toMatch(/görseli/);
      expect(attachedJson.campaign.readiness.reasons.join()).toMatch(/gizlilik politikası/);

      const gif = Buffer.from("GIF89a------------------------").toString("base64");
      expect((await upload(id, { filename: "x.gif", dataBase64: gif })).status).toBe(422);
      const img = await upload(id, { filename: "gorsel.png", dataBase64: pngBase64() });
      expect(img.status).toBe(200);
      expect((await img.json()).campaign.imageHash).toMatch(/^mockhash/);

      const noPrivacy = await submit(id);
      expect(noPrivacy.status).toBe(422);
      expect((await noPrivacy.json()).error).toMatch(/gizlilik politikası/);
      await prisma.organization.update({ where: { id: orgIds[0] }, data: { privacyPolicyUrl: "https://klinik.example/gizlilik" } });
      expect((await submit(id)).status).toBe(200);
      // İnceleme sırasında içerik ve görsel kilitli (onaylanan = yayınlanan).
      expect((await attach(id, { draftIds: [drafts.DE] })).status).toBe(409);
      expect((await upload(id, { filename: "g.png", dataBase64: pngBase64() })).status).toBe(409);
      expect((await approve(id)).status).toBe(200);

      const spies = spyMeta();
      const pub = await publish(id, "PUBLISH");
      expect(pub.status).toBe(200);
      const pubJson = await pub.json();
      expect(pubJson.publish).toMatchObject({ status: "COMPLETE", progress: { adSets: { total: 2, published: 2 }, ads: { expected: 4, published: 4 }, leadForms: 2, creatives: 4 } });
      expect(pubJson.campaign).toMatchObject({ workflowStatus: "PUBLISHED_PAUSED", status: "PAUSED" });
      expect(pubJson.campaign.metaCampaignId).toMatch(/^cmp_mock_pub_\d+$/);
      expect((await publish(id, "PUBLISH")).status).toBe(409);

      // Almanya pazarı içerik dillerine bölündü: DE + TR ad set, ABO 20.000 → 10.000 + 10.000.
      const adSets = await prisma.adSet.findMany({ where: { campaignId: id }, orderBy: { name: "asc" } });
      expect(adSets.map((a) => [(a.targeting as { language?: string }).language, a.dailyBudget, a.status, Boolean(a.metaAdSetId)])).toEqual([
        ["DE", 10_000, "PAUSED", true],
        ["TR", 10_000, "PAUSED", true],
      ]);
      const ads = await prisma.ad.findMany({ where: { adSet: { campaignId: id } } });
      expect(ads).toHaveLength(4);
      expect(ads.every((a) => a.status === "PAUSED" && a.metaAdId && a.metaCreativeId)).toBe(true);

      expect(spies.createCampaign).toHaveBeenCalledTimes(1);
      expect(spies.createCampaign.mock.calls[0]![0]).toMatchObject({ status: "PAUSED", budgetStrategy: "ABO", objective: "MAX_CONVERSIONS", dailyBudgetCents: 20_000 });
      const adSetBodies = spies.createAdSet.mock.calls.map((c) => c[1] as Body);
      expect(adSetBodies).toHaveLength(2);
      for (const body of adSetBodies) {
        expect(body).toMatchObject({ status: "PAUSED", optimization_goal: "LEAD_GENERATION", destination_type: "ON_AD", billing_event: "IMPRESSIONS", daily_budget: 10_000 });
        expect(json(body, "promoted_object")).toEqual({ page_id: "page_mock_1" });
      }
      expect(adSetBodies.map((b) => json(b, "targeting").locales)).toEqual([[5], [19]]); // German, Turkish (mock katalog)
      expect(json(adSetBodies[0]!, "targeting")).toMatchObject({ geo_locations: { countries: ["DE"] }, age_min: 18 });
      expect(spies.createLeadForm).toHaveBeenCalledTimes(2);
      for (const call of spies.createLeadForm.mock.calls) {
        expect(call[0]).toBe("page_mock_1");
        expect(call[2]).toBe("mock-page-token");
        const body = call[1] as Body;
        expect(json(body, "privacy_policy")).toMatchObject({ url: "https://klinik.example/gizlilik" });
        const disclaimer = json(body, "custom_disclaimer") as { checkboxes: { is_required: boolean }[] };
        expect(disclaimer.checkboxes[0]).toMatchObject({ is_required: true });
      }
      expect((spies.createLeadForm.mock.calls[1]![1] as Body).locale).toBe("TR_TR");
      // Her form, kişinin göreceği rıza metninin kopyasıyla kaydedilir (gelen lead'in kutu yanıtı → ConsentRecord).
      const forms = await prisma.leadForm.findMany({ where: { campaignId: id }, orderBy: { language: "asc" } });
      expect(forms.map((f) => [f.language, f.consentKey, f.consentRequired, f.pageId, f.orgId])).toEqual([
        ["DE", "kvkk_consent", true, "page_mock_1", orgIds[0]],
        ["TR", "kvkk_consent", true, "page_mock_1", orgIds[0]],
      ]);
      expect(forms.every((f) => /^lf_mock_/.test(f.metaFormId) && f.privacyPolicyUrl === "https://klinik.example/gizlilik")).toBe(true);
      expect(forms[0]!.consentText).toContain("Ich willige");
      expect(forms[1]!.consentText).toContain("kişisel verilerimin işlenmesine açık rıza veriyorum");
      expect(forms[1]!.consentText).toContain("https://klinik.example/gizlilik");
      expect(spies.createAdCreative).toHaveBeenCalledTimes(4);
      for (const call of spies.createAdCreative.mock.calls) {
        const spec = json(call[1] as Body, "object_story_spec") as { page_id: string; link_data: Record<string, unknown> };
        expect(spec.page_id).toBe("page_mock_1");
        expect(spec.link_data).toMatchObject({ link: "http://fb.me/", image_hash: expect.stringMatching(/^mockhash/) });
        expect((spec.link_data.call_to_action as { value: { lead_gen_form_id: string } }).value.lead_gen_form_id).toMatch(/^lf_mock_/);
      }
      expect(spies.createAd).toHaveBeenCalledTimes(4);
      expect(spies.createAd.mock.calls.every((c) => (c[1] as Body).status === "PAUSED")).toBe(true);
      expect(spies.setStatus).not.toHaveBeenCalled();

      // Etkinleştirme: harcama yetkisi olmayan MEDIA_BUYER/ADMIN reddedilir.
      cookieJar.set(SESSION_COOKIE, tokenBuyer);
      expect((await publish(id, "ACTIVATE")).status).toBe(403);
      cookieJar.set(SESSION_COOKIE, tokenAdmin);
      expect((await publish(id, "ACTIVATE")).status).toBe(403);
      expect(spies.setStatus).not.toHaveBeenCalled();

      // Toplam aylık üst sınır: aktif kampanya 15.000/gün (450.000) + bu kampanya 600.000 > 1.000.000.
      const account = await prisma.adAccount.findFirstOrThrow({ where: { orgId: orgIds[0] } });
      const committed = await prisma.campaign.create({ data: {
        adAccountId: account.id, workspaceId: workspaceIds[0], name: "Aktif başka kampanya", dailyBudget: 15_000,
        status: "ACTIVE", workflowStatus: "ACTIVE", metaCampaignId: `other-${suffix}`,
      } });
      campaignIds.push(committed.id);
      cookieJar.set(SESSION_COOKIE, tokenOwner);
      const overCap = await publish(id, "ACTIVATE");
      expect(overCap.status).toBe(422);
      expect((await overCap.json()).error).toMatch(/aktif kampanyalar/);
      expect(spies.setStatus).not.toHaveBeenCalled();
      expect((await prisma.campaign.findUniqueOrThrow({ where: { id } })).status).toBe("PAUSED");
      await prisma.campaign.update({ where: { id: committed.id }, data: { status: "PAUSED", workflowStatus: "PUBLISHED_PAUSED" } });

      // Owner'ın yetki verdiği MEDIA_BUYER etkinleştirebilir; sıra: reklamlar → ad set'ler → kampanya.
      expect((await grant(buyerId, true)).status).toBe(200);
      cookieJar.set(SESSION_COOKIE, tokenBuyer);
      const active = await publish(id, "ACTIVATE");
      expect(active.status).toBe(200);
      const activeJson = await active.json();
      expect(activeJson.campaign).toMatchObject({ workflowStatus: "ACTIVE", status: "ACTIVE", adsActivated: 4, adSetsActivated: 2 });
      const order = spies.setStatus.mock.calls.map((c) => (c[0] as { entityType: string }).entityType);
      expect(order).toEqual(["ad", "ad", "ad", "ad", "adset", "adset", "campaign"]);
      expect(spies.setStatus.mock.calls.every((c) => (c[0] as { status: string }).status === "ACTIVE")).toBe(true);
      expect((await prisma.ad.findMany({ where: { adSet: { campaignId: id } } })).every((a) => a.status === "ACTIVE")).toBe(true);
      cookieJar.set(SESSION_COOKIE, tokenOwner);
      expect((await grant(buyerId, false)).status).toBe(200);

      const pause = await publish(id, "PAUSE");
      expect((await pause.json()).campaign.workflowStatus).toBe("PUBLISHED_PAUSED");
      // Yetkisi geri alınan üye yeniden etkinleştiremez.
      cookieJar.set(SESSION_COOKIE, tokenBuyer);
      expect((await publish(id, "ACTIVATE")).status).toBe(403);
      cookieJar.set(SESSION_COOKIE, tokenOwner);
      const archive = await publish(id, "ARCHIVE");
      expect((await archive.json()).campaign.workflowStatus).toBe("ARCHIVED");

      const actions = (await prisma.auditLog.findMany({ where: { entityId: id }, orderBy: { createdAt: "asc" } })).map((l) => l.action);
      expect(actions).toEqual([
        "CAMPAIGN_CREATED", "CAMPAIGN_CONTENT_ATTACHED", "CAMPAIGN_IMAGE_UPLOADED", "CAMPAIGN_SUBMITTED", "CAMPAIGN_APPROVED",
        "CAMPAIGN_PUBLISHED", "CAMPAIGN_ACTIVATED", "CAMPAIGN_PAUSED", "CAMPAIGN_ARCHIVED",
      ]);
      const activated = await prisma.auditLog.findFirstOrThrow({ where: { entityId: id, action: "CAMPAIGN_ACTIVATED" } });
      expect(activated.userId).toBe(buyerId);
      expect(activated.after).toMatchObject({ monthlyCapCents: 1_000_000, monthlyProjectedCents: 600_000, adsActivated: 4 });
      const stored = await prisma.campaign.findUniqueOrThrow({ where: { id } });
      expect(stored.metaRejectionReason).toBeNull();
    });

    it("a failed Meta step keeps resumable progress; retrying continues without duplicating objects (WhatsApp, CBO)", async () => {
      const id = await approvedCampaign(
        { name: `WhatsApp ${suffix}`, objective: "MAX_CONVERSIONS", budget: 100, markets: ["GB"], strategy: "CBO", conversionMethod: "whatsapp" },
        ["EN"],
      );
      const spies = spyMeta();
      mockMetaFailures.fail("createAd", 1);
      const failed = await publish(id, "PUBLISH");
      expect(failed.status).toBe(502);
      expect((await failed.json()).error).toMatch(/"reklam" adımında durdu/);
      const partial = await prisma.campaign.findUniqueOrThrow({ where: { id } });
      expect(partial.workflowStatus).toBe("APPROVED");
      expect(partial.metaCampaignId).toMatch(/^cmp_mock_pub_/);
      expect(partial.publishLockedUntil).toBeNull();
      expect(partial.publishState).toMatchObject({ lastError: { step: "ads" }, attempts: 1 });
      const listed = (await (await campaignsGet()).json()).campaigns.find((c: { id: string }) => c.id === id);
      expect(listed.publish).toMatchObject({ status: "IN_PROGRESS", campaignCreated: true, lastError: { step: "ads" } });
      expect(await prisma.auditLog.count({ where: { entityId: id, action: "CAMPAIGN_PUBLISH_FAILED" } })).toBe(1);

      const resumed = await publish(id, "PUBLISH");
      expect(resumed.status).toBe(200);
      expect((await resumed.json()).publish.status).toBe("COMPLETE");
      expect(spies.createCampaign).toHaveBeenCalledTimes(1);
      expect(spies.createAdSet).toHaveBeenCalledTimes(1);
      expect(spies.createAdCreative).toHaveBeenCalledTimes(2);
      expect(spies.createAd).toHaveBeenCalledTimes(3); // 1 başarısız + 2 başarılı
      expect(spies.createLeadForm).not.toHaveBeenCalled();
      expect(spies.createCampaign.mock.calls[0]![0]).toMatchObject({ budgetStrategy: "CBO", dailyBudgetCents: 10_000 });
      const adSetBody = spies.createAdSet.mock.calls[0]![1] as Body;
      expect(adSetBody).toMatchObject({ destination_type: "WHATSAPP", optimization_goal: "CONVERSATIONS" });
      expect(adSetBody).not.toHaveProperty("daily_budget");
      expect(json(adSetBody, "targeting").locales).toEqual([1001]); // English (All)
      const spec = json(spies.createAdCreative.mock.calls[0]![1] as Body, "object_story_spec") as { link_data: Record<string, unknown> };
      expect(spec.link_data).toMatchObject({ link: "https://api.whatsapp.com/send", call_to_action: { type: "WHATSAPP_MESSAGE" } });
      const done = await prisma.campaign.findUniqueOrThrow({ where: { id } });
      expect(done.workflowStatus).toBe("PUBLISHED_PAUSED");
      expect(done.publishState).toMatchObject({ attempts: 2, completedAt: expect.any(String) });
      expect(done.publishState).not.toHaveProperty("lastError");
      expect(await prisma.ad.count({ where: { adSet: { campaignId: id } } })).toBe(2);
    });

    it("a time-boxed publish makes progress on every call and completes (landing page → LINK_CLICKS)", async () => {
      const landing = "https://klinik.example/sac-ekimi";
      const id = await approvedCampaign(
        { name: `Açılış ${suffix}`, objective: "MAX_ROAS", budget: 100, markets: ["GB"], strategy: "ABO", conversionMethod: "landing_form" },
        ["EN"],
        landing,
      );
      const spies = spyMeta();
      const statuses: string[] = [];
      for (let round = 0; round < 12; round++) {
        const result = await publishCampaign(ownerActor(), id, { budgetMs: 0 });
        statuses.push(result.status);
        if (result.status === "COMPLETE") break;
      }
      // Her çağrı tek Meta nesnesi: kampanya, locale, ad set, 2 kreatif, 2 reklam = 7 tur.
      expect(statuses).toEqual(["IN_PROGRESS", "IN_PROGRESS", "IN_PROGRESS", "IN_PROGRESS", "IN_PROGRESS", "IN_PROGRESS", "COMPLETE"]);
      const adSetBody = spies.createAdSet.mock.calls[0]![1] as Body;
      expect(adSetBody).toMatchObject({ destination_type: "WEBSITE", optimization_goal: "LINK_CLICKS", daily_budget: 10_000 });
      expect(adSetBody).not.toHaveProperty("promoted_object");
      const spec = json(spies.createAdCreative.mock.calls[0]![1] as Body, "object_story_spec") as { link_data: Record<string, unknown> };
      expect(spec.link_data).toMatchObject({ link: landing, call_to_action: { type: "SIGN_UP", value: { link: landing } } });
      const features = json(spies.createAdCreative.mock.calls[0]![1] as Body, "degrees_of_freedom_spec") as { creative_features_spec: Record<string, { enroll_status: string }> };
      expect(features.creative_features_spec.text_optimizations).toEqual({ enroll_status: "OPT_OUT" });
      expect((await prisma.campaign.findUniqueOrThrow({ where: { id } })).workflowStatus).toBe("PUBLISHED_PAUSED");
    });

    it("an abandoned half-finished publish can be archived after pausing it in Meta", async () => {
      const id = await approvedCampaign(
        { name: `Yarım ${suffix}`, objective: "MAX_CONVERSIONS", budget: 100, markets: ["GB"], strategy: "ABO", conversionMethod: "instant_form" },
        ["EN"],
      );
      mockMetaFailures.fail("createAdSet", 1);
      expect((await publish(id, "PUBLISH")).status).toBe(502);
      const spies = spyMeta();
      const archived = await publish(id, "ARCHIVE");
      expect(archived.status).toBe(200);
      expect((await archived.json()).campaign.workflowStatus).toBe("ARCHIVED");
      expect(spies.setStatus).toHaveBeenCalledWith(expect.objectContaining({ entityType: "campaign", status: "PAUSED" }), "mock-token");
      const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: id, action: "CAMPAIGN_ARCHIVED" } });
      expect(audit.after).toMatchObject({ partialPublish: true });
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
      expect((await attach(mine.campaign.id, { draftIds: [drafts.FOREIGN] })).status).toBe(404);
      expect((await upload(mine.campaign.id, { filename: "g.png", dataBase64: pngBase64() })).status).toBe(404);
      expect((await publish(mine.campaign.id, "PUBLISH")).status).toBe(404);
    });
  },
);

import { beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({
  actor: { orgId: "org", workspaceId: "ws", userId: "owner", role: "OWNER" },
  // dailyBudget minor unit (ADR-0011): 100,00 = 10_000 cent.
  campaign: {
    id: "campaign", name: "Fixture", dailyBudget: 10000, objective: "MAX_CONVERSIONS", workflowStatus: "APPROVED", status: "PAUSED",
    metaCampaignId: null as string | null, plan: null as unknown, content: null as unknown, imageHash: null as string | null,
    publishState: null as unknown, publishLockedUntil: null as Date | null,
    adAccount: { connectionId: "conn", metaAccountId: "act_account" as string | null, currency: "EUR" },
  },
  create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), adSetCreate: vi.fn(), account: vi.fn(), audit: vi.fn(),
  policy: vi.fn(), createCampaign: vi.fn(), setStatus: vi.fn(), cap: 1_000_000 as number | null, live: { token: "fixture", mockMode: false },
  clinic: { bannedPhrases: [] as string[], marketLanguages: {} as Record<string, string[]> },
  // Aktif kampanyaların aylık toplamı için (status=ACTIVE) satırlar.
  committed: [] as { dailyBudget: number | null; lifetimeBudget: number | null; budgetType: string | null }[],
  canApproveSpend: false,
  ads: [{ metaAdId: "ad-1" }, { metaAdId: "ad-2" }], adSets: [{ metaAdSetId: "as-1" }],
}));
vi.mock("@admedic/config", () => ({ loadEnv: () => ({ AUTH_URL: "http://localhost:3000" }) }));
vi.mock("../app/_lib/auth", () => ({
  EDIT_ROLES: ["OWNER", "ADMIN", "MEDIA_BUYER"], requireActor: async () => f.actor,
  requireRole: (actor: { role: string }, roles: string[]) => {
    if (!roles.includes(actor.role)) throw new Error("forbidden");
  },
}));
vi.mock("../app/_lib/audit", () => ({ logAudit: (...args: unknown[]) => f.audit(...args) }));
vi.mock("../app/_lib/policy-loader", () => ({ checkPolicyWithRules: (...args: unknown[]) => f.policy(...args) }));
vi.mock("../app/_lib/campaign-workflow", () => ({
  ownedCampaign: async () => f.campaign,
  lockCampaignRow: async () => undefined,
  campaignPolicyText: (c: { name: string }) => c.name,
  clinicPolicyContext: async () => f.clinic,
}));
vi.mock("../app/_lib/meta-connection", () => ({ requireLiveMetaConnection: async () => f.live }));
vi.mock("@admedic/meta-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@admedic/meta-api")>()),
  createMetaClient: () => ({ createCampaign: f.createCampaign, setStatus: f.setStatus }),
}));
vi.mock("@admedic/database", () => {
  const db = {
    $queryRaw: vi.fn(),
    campaign: {
      create: f.create, update: f.update, updateMany: f.updateMany,
      findFirst: async () => f.campaign, findMany: async () => f.committed,
    },
    adSet: { create: f.adSetCreate, findMany: async () => f.adSets, updateMany: async () => ({ count: 1 }) },
    ad: { findMany: async () => f.ads, updateMany: async () => ({ count: 1 }) },
    adAccount: { findFirst: f.account },
    membership: { findUnique: async () => ({ role: f.actor.role, status: "ACTIVE", canApproveSpend: f.canApproveSpend }) },
    organization: {
      findUnique: async () => ({ monthlyAdBudgetCap: f.cap }),
      findUniqueOrThrow: async () => ({ monthlyAdBudgetCap: f.cap, privacyPolicyUrl: null, consentText: null }),
    },
  };
  return { Prisma: {}, prisma: { ...db, $transaction: (run: (tx: typeof db) => unknown) => run(db) } };
});
import { POST as create } from "../app/api/campaigns/route";
import { POST as publish } from "../app/api/campaigns/[id]/publish/route";
const request = (body: unknown) => new Request("http://localhost:3000/api/campaigns", {
  method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/json" }, body: JSON.stringify(body),
});
const action = (value: string) => publish(request({ action: value }), { params: Promise.resolve({ id: "campaign" }) });
const auditCalls = () => f.audit.mock.calls.map(([arg]) => arg as { action: string; after?: Record<string, unknown> });

describe("campaign safety", () => {
  beforeEach(() => {
    vi.clearAllMocks(); f.actor.role = "OWNER"; f.cap = 1_000_000; f.committed = []; f.canApproveSpend = false;
    f.ads = [{ metaAdId: "ad-1" }, { metaAdId: "ad-2" }]; f.adSets = [{ metaAdSetId: "as-1" }];
    f.live = { token: "fixture", mockMode: false };
    f.clinic = { bannedPhrases: [], marketLanguages: {} };
    Object.assign(f.campaign, { workflowStatus: "APPROVED", status: "PAUSED", metaCampaignId: null, plan: null, dailyBudget: 10000, publishState: null, content: null, imageHash: null });
    f.campaign.adAccount.metaAccountId = "act_account";
    f.account.mockResolvedValue({ id: "account", currency: "EUR" });
    f.policy.mockResolvedValue({ risk: "LOW", findings: [] });
    f.create.mockImplementation(async ({ data }) => ({ ...data, id: "campaign", workflowStatus: "DRAFT" }));
    f.updateMany.mockResolvedValue({ count: 1 });
    f.createCampaign.mockResolvedValue({ success: true, campaignId: "remote" });
    f.setStatus.mockResolvedValue({ success: true });
  });
  it("blocks underage targeting without requiring a plan or market", async () => {
    expect((await create(request({ name: "Fixture", budget: 100, ageMin: 17 }))).status).toBe(422);
    expect(f.create).not.toHaveBeenCalled();
  });
  it("stores major input as cents and allocates exactly the ABO budget per market in PAUSED state", async () => {
    const res = await create(request({ name: "Fixture", budget: 101, markets: ["DE", "GB", "TR"], strategy: "ABO" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.campaign).toMatchObject({ budgetCents: 10100, budget: 101, currency: "EUR", adSets: 3 });
    expect(f.account).toHaveBeenCalledWith(expect.objectContaining({ where: { orgId: "org", workspaceId: "ws", status: "ACTIVE" } }));
    expect(f.create.mock.calls[0][0].data).toMatchObject({ dailyBudget: 10100, budgetType: "DAILY", status: "PAUSED" });
    const rows = f.adSetCreate.mock.calls.map(([arg]) => arg.data);
    expect(rows.map((r) => r.dailyBudget)).toEqual([3367, 3367, 3366]);
    expect(rows.every((r) => r.status === "PAUSED" && r.bidStrategy === "ABO")).toBe(true);
    expect(rows[0].targeting).toMatchObject({ geo_locations: { countries: ["DE"] }, locales: ["DE", "TR"], age_min: 18, age_max: 54, market: "DE" });
    expect(auditCalls()[0]).toMatchObject({ action: "CAMPAIGN_CREATED", after: { dailyBudgetCents: 10100, adSets: 3 } });
  });
  it("accepts decimal budgets and rounds to cents", async () => {
    expect((await create(request({ name: "Fixture", budget: 12.345 }))).status).toBe(200);
    expect(f.create.mock.calls[0][0].data.dailyBudget).toBe(1235);
  });
  it("keeps CBO budget only at campaign level and limits ad sets to three markets", async () => {
    expect((await create(request({ name: "Fixture", budget: 101, markets: ["DE", "GB", "TR", "GULF"], strategy: "CBO" }))).status).toBe(200);
    expect(f.adSetCreate).toHaveBeenCalledTimes(3);
    expect(f.adSetCreate.mock.calls.every(([arg]) => arg.data.dailyBudget === null)).toBe(true);
  });
  it("evaluates the monthly cap in cents on draft creation", async () => {
    f.cap = 300_000; // 3.000,00 → 101 × 30 gün = 303.000 cent > cap
    expect((await create(request({ name: "Fixture", budget: 101 }))).status).toBe(422);
    expect((await create(request({ name: "Fixture", budget: 100 }))).status).toBe(200);
  });
  it("feeds clinic banned phrases into the policy check and reports medium risk as a warning", async () => {
    f.clinic = { bannedPhrases: ["ucuz"], marketLanguages: {} };
    f.policy.mockResolvedValue({ risk: "MEDIUM", findings: [{ rule: "clinic-restriction", reason: "Klinik tarafından yasaklanan ifade bulundu." }] });
    const res = await create(request({ name: "Ucuz saç ekimi", budget: 50 }));
    expect(res.status).toBe(200);
    expect(f.policy).toHaveBeenCalledWith("Ucuz saç ekimi", ["ucuz"]);
    expect((await res.json()).campaign.policyWarning).toContain("yasaklanan");
  });
  it("evaluates the monthly cap against active campaigns plus the new draft", async () => {
    f.cap = 600_000;
    f.committed = [{ dailyBudget: 10_000, lifetimeBudget: null, budgetType: "DAILY" }]; // 300.000 cent/ay aktif
    const over = await create(request({ name: "Fixture", budget: 101 })); // 303.000 + 300.000 > 600.000
    expect(over.status).toBe(422);
    expect((await over.json()).error).toMatch(/aktif kampanyalar/);
    expect((await create(request({ name: "Fixture", budget: 100 }))).status).toBe(200); // tam sınırda
  });
  it("refuses plans whose objective and conversion method cannot be published to Meta", async () => {
    const res = await create(request({ name: "Fixture", budget: 50, markets: ["DE"], objective: "MAX_ROAS", conversionMethod: "instant_form" }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/Anında Form/);
    expect((await create(request({ name: "Fixture", budget: 50, markets: ["DE"], conversionMethod: "instagram_dm" }))).status).toBe(422);
    expect(f.create).not.toHaveBeenCalled();
  });
  it("blocks publish before approval and activation without spend authority", async () => {
    f.campaign.workflowStatus = "DRAFT";
    expect((await action("PUBLISH")).status).toBe(409);
    Object.assign(f.campaign, { workflowStatus: "PUBLISHED_PAUSED", metaCampaignId: "remote", publishState: { version: 1, completedAt: "t" } });
    f.actor.role = "MEDIA_BUYER";
    expect((await action("ACTIVATE")).status).toBe(403);
    f.actor.role = "ADMIN";
    expect((await action("ACTIVATE")).status).toBe(403);
    expect(f.createCampaign).not.toHaveBeenCalled(); expect(f.setStatus).not.toHaveBeenCalled();
  });
  it("rechecks current policy before publishing and refuses a campaign that is not ready for Meta", async () => {
    f.policy.mockResolvedValue({ risk: "HIGH", findings: [] });
    expect((await action("PUBLISH")).status).toBe(422);
    f.policy.mockResolvedValue({ risk: "LOW", findings: [] });
    const notReady = await action("PUBLISH");
    expect(notReady.status).toBe(422);
    expect((await notReady.json()).error).toMatch(/planlayıcı/);
    expect(f.createCampaign).not.toHaveBeenCalled();
  });
  it("an externally created (synced) campaign activates only at campaign level, with the same authority and cap rules", async () => {
    Object.assign(f.campaign, { workflowStatus: "PUBLISHED_PAUSED", metaCampaignId: "remote" });
    f.updateMany.mockResolvedValue({ count: 1 });
    expect((await action("ACTIVATE")).status).toBe(200);
    expect(f.setStatus.mock.calls.map(([arg]) => `${arg.entityType}:${arg.entityId}`)).toEqual(["campaign:remote"]);
    expect(auditCalls().at(-1)).toMatchObject({ action: "CAMPAIGN_ACTIVATED", after: { scope: "campaign", adsActivated: 0 } });
  });
  it("a fully published campaign rechecks policy and activates ads → ad sets → campaign", async () => {
    Object.assign(f.campaign, { workflowStatus: "PUBLISHED_PAUSED", metaCampaignId: "remote" });
    f.campaign.publishState = { version: 1, completedAt: "2026-09-27T00:00:00.000Z" };
    f.ads = [];
    expect((await action("ACTIVATE")).status).toBe(409); // tam yayında reklam yoksa etkinleştirme yok
    f.ads = [{ metaAdId: "ad-1" }, { metaAdId: "ad-2" }];
    f.policy.mockResolvedValue({ risk: "HIGH", findings: [] });
    expect((await action("ACTIVATE")).status).toBe(422);
    expect(f.setStatus).not.toHaveBeenCalled();
    f.policy.mockResolvedValue({ risk: "LOW", findings: [] });
    f.updateMany.mockResolvedValue({ count: 1 });
    const res = await action("ACTIVATE");
    expect(res.status).toBe(200);
    expect(f.setStatus.mock.calls.map(([arg]) => `${arg.entityType}:${arg.entityId}:${arg.status}`)).toEqual([
      "ad:ad-1:ACTIVE", "ad:ad-2:ACTIVE", "adset:as-1:ACTIVE", "campaign:remote:ACTIVE",
    ]);
    // Rezervasyon (status=ACTIVE) Meta çağrılarından önce yazılır.
    expect(f.update).toHaveBeenCalledWith({ where: { id: "campaign" }, data: { status: "ACTIVE" } });
    expect(auditCalls().at(-1)).toMatchObject({
      action: "CAMPAIGN_ACTIVATED",
      after: { scope: "cascade", adsActivated: 2, adSetsActivated: 1, monthlyCapCents: 1_000_000, monthlyCommittedCents: 0, monthlyProjectedCents: 300_000 },
    });
  });
  it("a delegated media buyer may activate; the committed monthly cap is enforced before any Meta call", async () => {
    Object.assign(f.campaign, { workflowStatus: "PUBLISHED_PAUSED", metaCampaignId: "remote", publishState: { version: 1, completedAt: "t" } });
    f.actor.role = "MEDIA_BUYER"; f.canApproveSpend = true;
    f.committed = [{ dailyBudget: 25_000, lifetimeBudget: null, budgetType: "DAILY" }]; // 750.000 + 300.000 > 1.000.000
    const over = await action("ACTIVATE");
    expect(over.status).toBe(422);
    expect((await over.json()).error).toMatch(/Aylık bütçe üst sınırı aşılıyor/);
    expect(f.update).not.toHaveBeenCalled(); expect(f.setStatus).not.toHaveBeenCalled();
    f.committed = [{ dailyBudget: 20_000, lifetimeBudget: null, budgetType: "DAILY" }];
    f.updateMany.mockResolvedValue({ count: 1 });
    expect((await action("ACTIVATE")).status).toBe(200);
  });
  it("releases the activation reservation and reports failure when Meta refuses", async () => {
    Object.assign(f.campaign, { workflowStatus: "PUBLISHED_PAUSED", metaCampaignId: "remote", publishState: { version: 1, completedAt: "t" } });
    f.setStatus.mockResolvedValueOnce({ success: true }).mockResolvedValueOnce({ success: false });
    f.updateMany.mockResolvedValue({ count: 1 });
    expect((await action("ACTIVATE")).status).toBe(502);
    expect(f.updateMany).toHaveBeenCalledWith({ where: { id: "campaign", workflowStatus: "PUBLISHED_PAUSED" }, data: { status: "PAUSED" } });
    expect(auditCalls().at(-1)).toMatchObject({ action: "CAMPAIGN_ACTIVATION_FAILED", after: { campaignActivated: false } });
  });
  it("uses a distinct audit action for pause", async () => {
    Object.assign(f.campaign, { workflowStatus: "ACTIVE", status: "ACTIVE", metaCampaignId: "remote" });
    f.updateMany.mockResolvedValue({ count: 1 });
    expect((await action("PAUSE")).status).toBe(200);
    expect(f.setStatus).toHaveBeenCalledWith({ entityType: "campaign", entityId: "remote", status: "PAUSED" }, "fixture");
    expect(auditCalls().at(-1)).toMatchObject({ action: "CAMPAIGN_PAUSED" });
  });
  it("stops remote spend before archiving, leaving local state untouched on failure", async () => {
    Object.assign(f.campaign, { workflowStatus: "ACTIVE", status: "ACTIVE", metaCampaignId: "remote" });
    f.setStatus.mockResolvedValue({ success: false });
    expect((await action("ARCHIVE")).status).toBe(502);
    expect(f.update).not.toHaveBeenCalled(); expect(f.updateMany).not.toHaveBeenCalled();
    f.setStatus.mockResolvedValue({ success: true });
    expect((await action("ARCHIVE")).status).toBe(200);
    expect(f.setStatus).toHaveBeenCalledWith({ entityType: "campaign", entityId: "remote", status: "PAUSED" }, "fixture");
    expect(auditCalls().at(-1)).toMatchObject({ action: "CAMPAIGN_ARCHIVED" });
  });
});

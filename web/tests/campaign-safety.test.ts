import { beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({
  actor: { orgId: "org", workspaceId: "ws", userId: "owner", role: "OWNER" },
  // dailyBudget minor unit (ADR-0011): 100,00 = 10_000 cent.
  campaign: { id: "campaign", name: "Fixture", dailyBudget: 10000, objective: "MAX_CONVERSIONS", workflowStatus: "APPROVED", status: "PAUSED", metaCampaignId: null as string | null, plan: null as unknown, adAccount: { connectionId: "conn", metaAccountId: "act_account" as string | null } },
  create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), adSetCreate: vi.fn(), account: vi.fn(), audit: vi.fn(),
  policy: vi.fn(), createCampaign: vi.fn(), setStatus: vi.fn(), cap: 1_000_000, live: { token: "fixture", mockMode: false },
  clinic: { bannedPhrases: [] as string[], marketLanguages: {} as Record<string, string[]> },
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
vi.mock("@admedic/meta-api", () => ({ MOCK_AD_ACCOUNT_ID: "act_mock_001", createMetaClient: () => ({ createCampaign: f.createCampaign, setStatus: f.setStatus }) }));
vi.mock("@admedic/database", () => {
  const db = {
    $queryRaw: vi.fn(),
    campaign: { create: f.create, update: f.update, updateMany: f.updateMany }, adSet: { create: f.adSetCreate },
    adAccount: { findFirst: f.account },
    organization: { findUnique: async () => ({ monthlyAdBudgetCap: f.cap }), findUniqueOrThrow: async () => ({ monthlyAdBudgetCap: f.cap }) },
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
    vi.clearAllMocks(); f.actor.role = "OWNER"; f.cap = 1_000_000;
    f.live = { token: "fixture", mockMode: false };
    f.clinic = { bannedPhrases: [], marketLanguages: {} };
    Object.assign(f.campaign, { workflowStatus: "APPROVED", status: "PAUSED", metaCampaignId: null, plan: null, dailyBudget: 10000 });
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
  it("blocks publish before approval and activation by a marketer", async () => {
    f.campaign.workflowStatus = "DRAFT";
    expect((await action("PUBLISH")).status).toBe(409);
    f.actor.role = "MEDIA_BUYER";
    expect((await action("ACTIVATE")).ok).toBe(false);
    expect(f.createCampaign).not.toHaveBeenCalled(); expect(f.setStatus).not.toHaveBeenCalled();
  });
  it("rechecks current policy and budget before publishing", async () => {
    f.policy.mockResolvedValue({ risk: "HIGH", findings: [] });
    expect((await action("PUBLISH")).status).toBe(422);
    f.policy.mockResolvedValue({ risk: "LOW", findings: [] }); f.cap = 100;
    expect((await action("PUBLISH")).status).toBe(422);
    expect(f.createCampaign).not.toHaveBeenCalled();
  });
  it("publishes only PAUSED with cents and does not record failed external actions", async () => {
    f.campaign.plan = { strategy: "ABO" };
    expect((await action("PUBLISH")).status).toBe(200);
    expect(f.createCampaign).toHaveBeenCalledWith(
      expect.objectContaining({ status: "PAUSED", dailyBudgetCents: 10000, budgetStrategy: "ABO", objective: "MAX_CONVERSIONS", accountId: "account" }),
      "fixture",
    );
    expect(f.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ workflowStatus: "APPROVED", metaCampaignId: null }),
      data: expect.objectContaining({ workflowStatus: "PUBLISHED_PAUSED", status: "PAUSED", metaCampaignId: "remote" }),
    }));
    expect(auditCalls()[0]).toMatchObject({ action: "CAMPAIGN_PUBLISHED", after: { metaCampaignId: "remote", action: "PUBLISH" } });
    f.update.mockClear(); f.updateMany.mockClear(); f.createCampaign.mockResolvedValue({ success: false });
    expect((await action("PUBLISH")).status).toBe(502);
    expect(f.update).not.toHaveBeenCalled(); expect(f.updateMany).not.toHaveBeenCalled();
  });
  it("keeps medium-risk warnings out of metaRejectionReason but returns and audits them", async () => {
    f.policy.mockResolvedValue({ risk: "MEDIUM", findings: [{ rule: "clinic-restriction", reason: "Klinik kısıtı" }] });
    const res = await action("PUBLISH");
    expect(res.status).toBe(200);
    expect((await res.json()).campaign.policyWarning).toBe("Klinik kısıtı");
    const data = f.updateMany.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("metaRejectionReason");
    expect(auditCalls()[0].after).toMatchObject({ policyWarning: "Klinik kısıtı" });
  });
  it("refuses to publish to the mock account in live mode when metaAccountId is missing", async () => {
    f.campaign.adAccount.metaAccountId = null;
    expect((await action("PUBLISH")).status).toBe(400);
    expect(f.createCampaign).not.toHaveBeenCalled();
    f.live = { token: "mock-token", mockMode: true };
    expect((await action("PUBLISH")).status).toBe(200);
    expect(f.createCampaign).toHaveBeenCalledWith(expect.objectContaining({ accountId: "mock_001" }), "mock-token");
  });
  it("audits the orphaned Meta campaign when the local write fails after a successful create", async () => {
    f.updateMany.mockResolvedValue({ count: 0 });
    const res = await action("PUBLISH");
    expect(res.status).toBe(409);
    const orphan = auditCalls().find((a) => a.action === "CAMPAIGN_PUBLISH_ORPHANED");
    expect(orphan?.after).toMatchObject({ metaCampaignId: "remote" });
  });
  it("uses distinct audit actions for activate/pause and rechecks policy on activation", async () => {
    Object.assign(f.campaign, { workflowStatus: "PUBLISHED_PAUSED", metaCampaignId: "remote" });
    f.policy.mockResolvedValue({ risk: "HIGH", findings: [] });
    expect((await action("ACTIVATE")).status).toBe(422);
    expect(f.setStatus).not.toHaveBeenCalled();
    f.policy.mockResolvedValue({ risk: "LOW", findings: [] });
    expect((await action("ACTIVATE")).status).toBe(200);
    expect(auditCalls().at(-1)).toMatchObject({ action: "CAMPAIGN_ACTIVATED" });
    Object.assign(f.campaign, { workflowStatus: "ACTIVE", status: "ACTIVE" });
    expect((await action("PAUSE")).status).toBe(200);
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

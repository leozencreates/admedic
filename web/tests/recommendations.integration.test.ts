import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { prisma, type Prisma, type Role } from "@admedic/database";
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

import { GET as listRecs, POST as generate } from "../app/api/recommendations/route";
import { GET as getRec, PATCH as patchRec } from "../app/api/recommendations/[id]/route";
import { POST as approve } from "../app/api/recommendations/[id]/approve/route";
import { POST as apply } from "../app/api/recommendations/[id]/apply/route";
import { GET as getExperiment, PATCH as patchExperiment } from "../app/api/experiments/[id]/route";
import { POST as syncExperiment } from "../app/api/experiments/[id]/sync/route";

const ORIGIN = "http://localhost:3000";
function req(url: string, method: string, bodyObj?: unknown, origin = ORIGIN) {
  return new Request(`${ORIGIN}${url}`, {
    method,
    headers: { origin, ...(bodyObj === undefined ? {} : { "content-type": "application/json" }) },
    body: bodyObj === undefined ? undefined : JSON.stringify(bodyObj),
  });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe.skipIf(process.env.STUDIO_DB_TEST !== "1")("recommendation pipeline: generate → approve → apply", () => {
  const suffix = randomBytes(8).toString("hex");
  const users: string[] = [];
  const orgs: string[] = [];
  const tokens: Record<string, string> = {};
  let orgId = "";
  let workspaceId = "";
  let foreignWorkspaceId = "";
  let accountId = "";
  let completedExperimentId = "";
  let runningExperimentId = "";
  let foreignExperimentId = "";
  let publishedCampaignId = "";
  let draftCampaignId = "";
  let noBudgetCampaignId = "";
  let foreignCampaignId = "";

  const metrics = [{ spend: 350, clicks: 1000, leads: 50 }, { spend: 350, clicks: 1000, leads: 110 }];
  const snapshot = {
    clinic: "Demo Klinik", service: "Saç ekimi", market: "DE", language: "de", duration: 7, budget: 700,
    variants: [{ headline: "Doğal görünüm", text: "Metin", cta: "Bilgi al" }, { headline: "Uzman ekip", text: "Metin", cta: "Bilgi al" }],
  };

  async function mkExperiment(wsId: string, status: "COMPLETED" | "RUNNING") {
    const draft = await prisma.studioDraft.create({ data: { workspaceId: wsId, name: `Taslak ${randomBytes(3).toString("hex")}`, content: snapshot, policy: { version: 1, risk: "LOW", findings: [] }, status: "APPROVED" } });
    const exp = await prisma.studioExperiment.create({ data: { draftId: draft.id, snapshot, metrics, status, elapsedDays: status === "COMPLETED" ? 7 : 2 } });
    return exp.id;
  }

  beforeAll(async () => {
    vi.stubEnv("META_MOCK_MODE", "true");
    for (const foreign of [false, true]) {
      const org = await prisma.organization.create({ data: {
        name: "Recommendation fixture", slug: `rec-${suffix}-${foreign}`, monthlyAdBudgetCap: 800_000,
        workspaces: { create: { name: "Rec", slug: "rec", currency: "EUR" } },
      }, include: { workspaces: true } });
      orgs.push(org.id);
      const wsId = org.workspaces[0].id;
      for (const role of (foreign ? ["OWNER"] : ["OWNER", "ADMIN", "MEDIA_BUYER", "VIEWER"]) as Role[]) {
        const user = await prisma.user.create({ data: { email: `${suffix}-${foreign}-${role}@example.invalid` } });
        users.push(user.id);
        await prisma.membership.create({ data: { orgId: org.id, userId: user.id, role } });
        const token = randomBytes(32).toString("hex");
        await prisma.webSession.create({ data: { tokenHash: tokenHash(token), userId: user.id, workspaceId: wsId, expiresAt: new Date(Date.now() + 600_000) } });
        tokens[foreign ? "FOREIGN" : role] = token;
      }
      const conn = await prisma.metaConnection.create({ data: { orgId: org.id, type: "AD_ACCOUNT", status: "CONNECTED" } });
      const account = await prisma.adAccount.create({ data: { orgId: org.id, workspaceId: wsId, connectionId: conn.id, name: "Rec account", currency: "EUR" } });
      if (foreign) {
        foreignWorkspaceId = wsId;
        foreignExperimentId = await mkExperiment(wsId, "COMPLETED");
        foreignCampaignId = (await prisma.campaign.create({ data: { adAccountId: account.id, workspaceId: wsId, name: "Yabancı", dailyBudget: 20_000, workflowStatus: "DRAFT" } })).id;
      } else {
        orgId = org.id;
        workspaceId = wsId;
        accountId = account.id;
        completedExperimentId = await mkExperiment(wsId, "COMPLETED");
        runningExperimentId = await mkExperiment(wsId, "RUNNING");
        publishedCampaignId = (await prisma.campaign.create({ data: {
          adAccountId: accountId, workspaceId, name: "Yayında", dailyBudget: 20_000, workflowStatus: "PUBLISHED_PAUSED", metaCampaignId: `meta-${suffix}`,
        } })).id;
        draftCampaignId = (await prisma.campaign.create({ data: { adAccountId: accountId, workspaceId, name: "Taslak", dailyBudget: 10_000, workflowStatus: "DRAFT" } })).id;
        noBudgetCampaignId = (await prisma.campaign.create({ data: { adAccountId: accountId, workspaceId, name: "Bütçesiz", workflowStatus: "DRAFT" } })).id;
      }
    }
  });
  beforeEach(() => { updateBudget.mockReset().mockResolvedValue({ success: true }); });
  afterAll(async () => {
    cookieJar.clear();
    await prisma.auditLog.deleteMany({ where: { orgId: { in: orgs } } });
    await prisma.organization.deleteMany({ where: { id: { in: orgs } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    vi.unstubAllEnvs();
    await prisma.$disconnect();
  });

  const as = (role: string) => cookieJar.set(SESSION_COOKIE, tokens[role]);
  async function mkRec(data: { type: "BUDGET_INCREASE" | "BUDGET_REALLOCATION" | "EXPERIMENT_END"; status: "PENDING" | "APPROVED"; action: Prisma.InputJsonObject; wsId?: string; experimentId?: string }) {
    return prisma.recommendation.create({ data: {
      workspaceId: data.wsId ?? workspaceId, experimentId: data.experimentId ?? completedExperimentId, type: data.type, status: data.status,
      title: "t", description: "d", reasoning: "r", action: data.action, expectedImpact: {}, evidence: [],
    } });
  }

  it("POST /api/recommendations: tenant izolasyonu, durum kontrolü, rol; PENDING kayıt + audit", async () => {
    as("OWNER");
    expect((await generate(req("/api/recommendations", "POST", { experimentId: foreignExperimentId }))).status).toBe(404);
    expect((await generate(req("/api/recommendations", "POST", { experimentId: runningExperimentId }))).status).toBe(409);
    expect((await generate(req("/api/recommendations", "POST", { experimentId: completedExperimentId }, "https://other.invalid"))).status).toBe(403);
    as("VIEWER");
    expect((await generate(req("/api/recommendations", "POST", { experimentId: completedExperimentId }))).status).toBe(403);
    as("MEDIA_BUYER");
    expect((await generate(req("/api/recommendations", "POST", { experimentId: completedExperimentId }))).status).toBe(403);

    as("OWNER");
    const res = await generate(req("/api/recommendations", "POST", { experimentId: completedExperimentId }));
    expect(res.status).toBe(200);
    const json = await res.json() as { recommendations: Array<{ id: string; type: string; status: string; action: Record<string, unknown>; reasoning: string }> };
    expect(json.recommendations).toHaveLength(1);
    expect(json.recommendations[0].type).toBe("BUDGET_REALLOCATION");
    expect(json.recommendations[0].status).toBe("PENDING");
    expect(json.recommendations[0].action).toMatchObject({ variantWinner: "B", budgetSplit: [70, 30] });
    const saved = await prisma.recommendation.findUniqueOrThrow({ where: { id: json.recommendations[0].id } });
    expect(saved.status).toBe("PENDING");
    expect(saved.workspaceId).toBe(workspaceId);
    expect(await prisma.auditLog.count({ where: { orgId, action: "RECOMMENDATIONS_GENERATED", entityId: completedExperimentId } })).toBe(1);

    // Yeniden üretim eski PENDING'i EXPIRED yapar.
    expect((await generate(req("/api/recommendations", "POST", { experimentId: completedExperimentId }))).status).toBe(200);
    expect((await prisma.recommendation.findUniqueOrThrow({ where: { id: saved.id } })).status).toBe("EXPIRED");

    // Liste yalnızca kendi workspace'ini görür.
    as("FOREIGN");
    const foreignList = await (await listRecs()).json() as { recommendations: Array<{ id: string }> };
    expect(foreignList.recommendations.some((r) => r.id === saved.id)).toBe(false);
    expect((await getRec(req(`/api/recommendations/${saved.id}`, "GET"), ctx(saved.id))).status).toBe(404);
  });

  it("apply yalnızca APPROVED öneriye izin verir; approve OWNER/ADMIN; PATCH tenant izolasyonu", async () => {
    const rec = await mkRec({ type: "BUDGET_REALLOCATION", status: "PENDING", action: { type: "BUDGET_REALLOCATION", variantWinner: "B", budgetSplit: [70, 30] } });
    as("OWNER");
    const pendingApply = await apply(req(`/api/recommendations/${rec.id}/apply`, "POST", { campaignId: publishedCampaignId }), ctx(rec.id));
    expect(pendingApply.status).toBe(409);
    as("MEDIA_BUYER");
    expect((await approve(req(`/api/recommendations/${rec.id}/approve`, "POST"), ctx(rec.id))).status).toBe(403);
    as("FOREIGN");
    expect((await approve(req(`/api/recommendations/${rec.id}/approve`, "POST"), ctx(rec.id))).status).toBe(404);
    expect((await patchRec(req(`/api/recommendations/${rec.id}`, "PATCH", { status: "REJECTED" }), ctx(rec.id))).status).toBe(404);
    as("ADMIN");
    expect((await approve(req(`/api/recommendations/${rec.id}/approve`, "POST"), ctx(rec.id))).status).toBe(200);
    expect((await approve(req(`/api/recommendations/${rec.id}/approve`, "POST"), ctx(rec.id))).status).toBe(409);
    const approved = await prisma.recommendation.findUniqueOrThrow({ where: { id: rec.id } });
    expect(approved.status).toBe("APPROVED");
    expect(approved.approvedAt).not.toBeNull();
    expect(await prisma.auditLog.count({ where: { orgId, action: "RECOMMENDATION_APPROVED", entityId: rec.id } })).toBe(1);

    // Hedef kampanya: yok → 422; yabancı → 404; bütçesiz → 422.
    as("MEDIA_BUYER");
    expect((await apply(req(`/api/recommendations/${rec.id}/apply`, "POST"), ctx(rec.id))).status).toBe(422);
    expect((await apply(req(`/api/recommendations/${rec.id}/apply`, "POST", { campaignId: foreignCampaignId }), ctx(rec.id))).status).toBe(404);
    expect((await apply(req(`/api/recommendations/${rec.id}/apply`, "POST", { campaignId: noBudgetCampaignId }), ctx(rec.id))).status).toBe(422);
    expect(updateBudget).not.toHaveBeenCalled();
    expect((await prisma.recommendation.findUniqueOrThrow({ where: { id: rec.id } })).status).toBe("APPROVED");

    // Yayındaki kampanyaya uygulama: %70 → 14.000 cent; Meta'ya cent gider; audit before/after cent.
    const ok = await apply(req(`/api/recommendations/${rec.id}/apply`, "POST", { campaignId: publishedCampaignId }), ctx(rec.id));
    expect(ok.status).toBe(200);
    const body = await ok.json() as { status: string; appliedCampaignId: string; dailyBudgetCents: number; previousDailyBudgetCents: number; metaSynced: boolean };
    expect(body).toMatchObject({ status: "APPLIED", appliedCampaignId: publishedCampaignId, dailyBudgetCents: 14_000, previousDailyBudgetCents: 20_000, metaSynced: true });
    expect(updateBudget).toHaveBeenCalledWith({ entityType: "campaign", entityId: `meta-${suffix}`, dailyBudgetCents: 14_000 }, "mock-token");
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: publishedCampaignId } })).dailyBudget).toBe(14_000);
    const applied = await prisma.recommendation.findUniqueOrThrow({ where: { id: rec.id } });
    expect(applied.status).toBe("APPLIED");
    expect(applied.action).toMatchObject({ campaignId: publishedCampaignId, appliedDailyBudgetCents: 14_000 });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { orgId, action: "RECOMMENDATION_APPLIED", entityId: rec.id } });
    expect(audit.before).toMatchObject({ dailyBudgetCents: 20_000 });
    expect(audit.after).toMatchObject({ dailyBudgetCents: 14_000, metaSynced: true });
    expect((await apply(req(`/api/recommendations/${rec.id}/apply`, "POST", { campaignId: publishedCampaignId }), ctx(rec.id))).status).toBe(409);
  });

  it("BUDGET_INCREASE: MEDIA_BUYER 403, OWNER ×1.2, aylık üst sınır 422, Meta hatasında değişiklik yok", async () => {
    await prisma.campaign.update({ where: { id: publishedCampaignId }, data: { dailyBudget: 20_000 } });
    const rec = await mkRec({ type: "BUDGET_INCREASE", status: "APPROVED", action: { type: "BUDGET_INCREASE", campaignId: publishedCampaignId } });
    as("MEDIA_BUYER");
    expect((await apply(req(`/api/recommendations/${rec.id}/apply`, "POST"), ctx(rec.id))).status).toBe(403);
    as("OWNER");
    updateBudget.mockRejectedValueOnce(new Error("upstream secret"));
    const failed = await apply(req(`/api/recommendations/${rec.id}/apply`, "POST"), ctx(rec.id));
    expect(failed.status).toBe(502);
    expect(await failed.text()).not.toContain("upstream secret");
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: publishedCampaignId } })).dailyBudget).toBe(20_000);
    expect((await prisma.recommendation.findUniqueOrThrow({ where: { id: rec.id } })).status).toBe("APPROVED");

    const ok = await apply(req(`/api/recommendations/${rec.id}/apply`, "POST"), ctx(rec.id));
    expect(ok.status).toBe(200);
    expect((await ok.json() as { dailyBudgetCents: number }).dailyBudgetCents).toBe(24_000);
    expect(updateBudget).toHaveBeenLastCalledWith({ entityType: "campaign", entityId: `meta-${suffix}`, dailyBudgetCents: 24_000 }, "mock-token");

    // Üst sınır: 800.000 cent/ay; 24.000 × 1.2 = 28.800 × 30 = 864.000 > 800.000 → 422 (ilk artış 24.000 × 30 = 720.000 sınır içinde).
    const capped = await mkRec({ type: "BUDGET_INCREASE", status: "APPROVED", action: { type: "BUDGET_INCREASE", campaignId: publishedCampaignId } });
    expect((await apply(req(`/api/recommendations/${capped.id}/apply`, "POST"), ctx(capped.id))).status).toBe(422);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: publishedCampaignId } })).dailyBudget).toBe(24_000);

    // Taslak kampanya: Meta çağrısı yok, yalnızca yerel bütçe.
    updateBudget.mockClear();
    const draftRec = await mkRec({ type: "BUDGET_INCREASE", status: "APPROVED", action: { type: "BUDGET_INCREASE", campaignId: draftCampaignId } });
    const draftRes = await apply(req(`/api/recommendations/${draftRec.id}/apply`, "POST"), ctx(draftRec.id));
    expect(draftRes.status).toBe(200);
    expect((await draftRes.json() as { metaSynced: boolean; dailyBudgetCents: number })).toMatchObject({ metaSynced: false, dailyBudgetCents: 12_000 });
    expect(updateBudget).not.toHaveBeenCalled();
  });

  it("desteklenmeyen türler (CONTINUE/EXPERIMENT_END) APPLIED olmaz; PATCH reddetme ve hedef kampanya seçimi", async () => {
    const cont = await mkRec({ type: "EXPERIMENT_END", status: "APPROVED", action: { type: "CONTINUE" } });
    as("OWNER");
    expect((await apply(req(`/api/recommendations/${cont.id}/apply`, "POST", { campaignId: publishedCampaignId }), ctx(cont.id))).status).toBe(422);
    expect((await prisma.recommendation.findUniqueOrThrow({ where: { id: cont.id } })).status).toBe("APPROVED");

    const rec = await mkRec({ type: "BUDGET_REALLOCATION", status: "PENDING", action: { type: "BUDGET_REALLOCATION", budgetSplit: [70, 30] } });
    // APPROVED/APPLIED PATCH ile verilemez (şema dışı → 400).
    expect((await patchRec(req(`/api/recommendations/${rec.id}`, "PATCH", { status: "APPROVED" }), ctx(rec.id))).status).toBe(400);
    expect((await patchRec(req(`/api/recommendations/${rec.id}`, "PATCH", { campaignId: foreignCampaignId }), ctx(rec.id))).status).toBe(404);
    const target = await patchRec(req(`/api/recommendations/${rec.id}`, "PATCH", { campaignId: draftCampaignId }), ctx(rec.id));
    expect(target.status).toBe(200);
    expect((await prisma.recommendation.findUniqueOrThrow({ where: { id: rec.id } })).action).toMatchObject({ campaignId: draftCampaignId });
    as("MEDIA_BUYER");
    expect((await patchRec(req(`/api/recommendations/${rec.id}`, "PATCH", { status: "REJECTED" }), ctx(rec.id))).status).toBe(403);
    as("OWNER");
    expect((await patchRec(req(`/api/recommendations/${rec.id}`, "PATCH", { status: "REJECTED" }), ctx(rec.id))).status).toBe(200);
    expect((await prisma.recommendation.findUniqueOrThrow({ where: { id: rec.id } })).status).toBe("REJECTED");
    expect((await patchRec(req(`/api/recommendations/${rec.id}`, "PATCH", { status: "REJECTED" }), ctx(rec.id))).status).toBe(409);
    expect(await prisma.auditLog.count({ where: { orgId, action: "RECOMMENDATION_REJECTED", entityId: rec.id } })).toBe(1);
    expect(foreignWorkspaceId).not.toBe(workspaceId);
  });

  it("deney uçları tenant izolasyonu: yabancı deney 404, sync her zaman açık mesajla 409", async () => {
    as("OWNER");
    expect((await getExperiment(req(`/api/experiments/${foreignExperimentId}`, "GET"), ctx(foreignExperimentId))).status).toBe(404);
    expect((await getExperiment(req(`/api/experiments/${completedExperimentId}`, "GET"), ctx(completedExperimentId))).status).toBe(200);
    const patchBody = { version: 1, metrics, elapsedDays: 7, status: "RUNNING" };
    expect((await patchExperiment(req(`/api/experiments/${foreignExperimentId}`, "PATCH", patchBody), ctx(foreignExperimentId))).status).toBe(404);
    expect((await syncExperiment(req(`/api/experiments/${foreignExperimentId}/sync`, "POST"), ctx(foreignExperimentId))).status).toBe(404);
    const sync = await syncExperiment(req(`/api/experiments/${runningExperimentId}/sync`, "POST"), ctx(runningExperimentId));
    expect(sync.status).toBe(409);
    expect((await sync.json() as { error: string }).error).toContain("manuel ölçüm");
    as("VIEWER");
    expect((await syncExperiment(req(`/api/experiments/${runningExperimentId}/sync`, "POST"), ctx(runningExperimentId))).status).toBe(403);
  });
});

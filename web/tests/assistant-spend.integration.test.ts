import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { prisma, type Role } from "@admedic/database";
import { tokenHash } from "../app/_lib/password";
import { SESSION_COOKIE } from "../app/_lib/auth";
import { ApiError } from "../app/_lib/client-api";

// Sesli asistan R3 araçları (ADR-0028 §3 "asistan yetki sınırı değildir", Faz 4): istemci harcama yetkisini yanlış
// bildirse (canApproveSpend: true) bile aracın ekran onayından sonra gönderdiği **aynı istek** sunucuda reddedilir.
// Araç dağıtıcısının `api` bağımlılığı, gerçek route işleyicilerini kullanıcının oturum çereziyle çağırır.

const { cookieJar, setStatus, updateBudget } = vi.hoisted(() => ({
  cookieJar: new Map<string, string>(),
  setStatus: vi.fn(),
  updateBudget: vi.fn(),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (key: string) => (cookieJar.has(key) ? { value: cookieJar.get(key) } : undefined),
    set: (key: string, value: string) => cookieJar.set(key, value),
    delete: (key: string) => cookieJar.delete(key),
  }),
}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@admedic/meta-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@admedic/meta-api")>()),
  createMetaClient: () => ({ setStatus, updateBudget }),
}));

import { GET as campaignGet } from "../app/api/campaigns/[id]/route";
import { PATCH as budgetPatch } from "../app/api/campaigns/[id]/budget/route";
import { POST as publishPost } from "../app/api/campaigns/[id]/publish/route";
import { GET as recommendationGet } from "../app/api/recommendations/[id]/route";
import { POST as applyPost } from "../app/api/recommendations/[id]/apply/route";
import { RefMap } from "../app/_lib/assistant/ref-map";
import { createToolRuntime, TOOL_MESSAGES } from "../app/_lib/assistant/runtime";
import type { AssistantEvent } from "../app/_lib/assistant/events";

const ORIGIN = "http://localhost:3000";

type Handler = (request: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
const ROUTES: { method: string; pattern: RegExp; handler: Handler }[] = [
  { method: "GET", pattern: /^\/api\/campaigns\/([^/]+)$/, handler: campaignGet },
  { method: "PATCH", pattern: /^\/api\/campaigns\/([^/]+)\/budget$/, handler: budgetPatch },
  { method: "POST", pattern: /^\/api\/campaigns\/([^/]+)\/publish$/, handler: publishPost },
  { method: "GET", pattern: /^\/api\/recommendations\/([^/]+)$/, handler: recommendationGet },
  { method: "POST", pattern: /^\/api\/recommendations\/([^/]+)\/apply$/, handler: applyPost },
];

/** `client-api.ts` `api()` ile aynı sözleşme: aynı kaynak, JSON gövde, hata → `ApiError(message, status)`. */
const writes: { method: string; url: string; status: number }[] = [];
async function routeApi<T>(url: string, method = "GET", data?: unknown): Promise<T> {
  const route = ROUTES.find((r) => r.method === method && r.pattern.test(url));
  if (!route) throw new Error(`Testte bağlanmamış uç: ${method} ${url}`);
  const id = decodeURIComponent(route.pattern.exec(url)![1]!);
  const response = await route.handler(
    new Request(`${ORIGIN}${url}`, {
      method,
      headers: { origin: ORIGIN, ...(data === undefined ? {} : { "content-type": "application/json" }) },
      body: data === undefined ? undefined : JSON.stringify(data),
    }),
    { params: Promise.resolve({ id }) },
  );
  if (method !== "GET") writes.push({ method, url, status: response.status });
  const result = (await response.json()) as { error?: string };
  if (!response.ok) throw new ApiError(result.error ?? "", response.status);
  return result as T;
}

describe.skipIf(process.env.STUDIO_DB_TEST !== "1")("sesli asistan R3: sunucu harcama yetkisi ve aylık tavan (ADR-0028 Faz 4)", () => {
  const suffix = randomBytes(8).toString("hex");
  const tokens: Record<string, string> = {};
  const userIds: string[] = [];
  let orgId = "";
  let workspaceId = "";
  let accountId = "";

  beforeAll(async () => {
    vi.stubEnv("META_MOCK_MODE", "true");
    const org = await prisma.organization.create({
      data: {
        name: "Voice spend fixture",
        slug: `voice-spend-${suffix}`,
        // minor unit (ADR-0011): 30.000,00 = 3_000_000 cent (aylık).
        monthlyAdBudgetCap: 3_000_000,
        workspaces: { create: { name: "Voice", slug: "voice" } },
      },
      include: { workspaces: true },
    });
    orgId = org.id;
    workspaceId = org.workspaces[0]!.id;
    for (const role of ["OWNER", "MEDIA_BUYER"] as Role[]) {
      const user = await prisma.user.create({ data: { email: `${suffix}-${role.toLowerCase()}@example.invalid` } });
      userIds.push(user.id);
      // MEDIA_BUYER'a harcama yetkisi verilmez (canApproveSpend false, varsayılan).
      await prisma.membership.create({ data: { orgId, userId: user.id, role } });
      const token = randomBytes(32).toString("hex");
      await prisma.webSession.create({
        data: { tokenHash: tokenHash(token), userId: user.id, workspaceId, expiresAt: new Date(Date.now() + 600_000) },
      });
      tokens[role] = token;
    }
    const conn = await prisma.metaConnection.create({ data: { orgId, type: "BUSINESS_MANAGER", status: "CONNECTED" } });
    const account = await prisma.adAccount.create({ data: { orgId, workspaceId, connectionId: conn.id, name: "Voice account" } });
    accountId = account.id;
  });

  beforeEach(() => {
    writes.length = 0;
    setStatus.mockReset().mockResolvedValue({ success: true });
    updateBudget.mockReset().mockResolvedValue({ success: true });
  });

  afterAll(async () => {
    cookieJar.clear();
    await prisma.auditLog.deleteMany({ where: { orgId } });
    await prisma.organization.deleteMany({ where: { id: orgId } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    vi.unstubAllEnvs();
    await prisma.$disconnect();
  });

  /** Meta'da yüklenmiş, duraklatılmış kampanya (günlük bütçe minor unit). */
  const pausedCampaign = (dailyBudget = 20_000) =>
    prisma.campaign.create({
      data: {
        adAccountId: accountId,
        workspaceId,
        name: "Sesli test kampanyası",
        dailyBudget,
        status: "PAUSED",
        workflowStatus: "PUBLISHED_PAUSED",
        metaCampaignId: `meta-${randomBytes(6).toString("hex")}`,
      },
    });

  /** Rolün oturumuyla çalışan araç dağıtıcısı. İstemci bilerek `canApproveSpend: true` bildirir (ön süzgeç atlanır). */
  function runtimeAs(role: "OWNER" | "MEDIA_BUYER", campaignId: string, recommendationId?: string) {
    cookieJar.set(SESSION_COOKIE, tokens[role]!);
    const refs = new RefMap();
    refs.ref("campaign", campaignId);
    if (recommendationId) refs.ref("recommendation", recommendationId);
    const events: AssistantEvent[] = [];
    const runtime = createToolRuntime({
      role,
      canApproveSpend: true,
      router: { push: () => undefined },
      api: routeApi,
      refs,
      reportEvent: (e) => {
        events.push(e);
      },
      pending: { timers: false },
    });
    return { runtime, events };
  }

  /** Aracı çağırır (bekleyen eylem), ardından ekrandaki pencereden onaylar; ajana dönen JSON'u verir. */
  async function callAndConfirmOnScreen(runtime: ReturnType<typeof runtimeAs>["runtime"], tool: string, params: Record<string, unknown>) {
    const prepared = JSON.parse(await runtime.clientTools[tool]!(params)) as Record<string, unknown>;
    expect(prepared.status, JSON.stringify(prepared)).toBe("awaiting_screen_confirmation");
    expect(writes).toEqual([]);
    return JSON.parse(await runtime.pending.confirmOnScreen(String(prepared.pendingId))) as Record<string, unknown>;
  }

  it("harcama yetkisi olmayan MEDIA_BUYER: activate_campaign isteği (POST publish ACTIVATE) 403; Meta'ya gidilmez", async () => {
    const c = await pausedCampaign();
    const { runtime, events } = runtimeAs("MEDIA_BUYER", c.id);
    const out = await callAndConfirmOnScreen(runtime, "activate_campaign", { ref: "c1" });
    expect(out).toEqual({ ok: false, error: TOOL_MESSAGES.spendForbidden, retryable: false });
    expect(writes).toEqual([{ method: "POST", url: `/api/campaigns/${c.id}/publish`, status: 403 }]);
    expect(setStatus).not.toHaveBeenCalled();
    expect(await prisma.campaign.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ status: "PAUSED", workflowStatus: "PUBLISHED_PAUSED" });
    expect(events.at(-1)).toMatchObject({ tool: "activate_campaign", risk: "R3", outcome: "denied" });
  });

  it("harcama yetkisi olmayan MEDIA_BUYER: increase_budget isteği (PATCH budget) 403; azaltma (R2) geçer", async () => {
    const c = await pausedCampaign();
    const { runtime } = runtimeAs("MEDIA_BUYER", c.id);
    const out = await callAndConfirmOnScreen(runtime, "increase_budget", { ref: "c1", dailyBudget: 300 });
    expect(out).toEqual({ ok: false, error: TOOL_MESSAGES.spendForbidden, retryable: false });
    expect(writes).toEqual([{ method: "PATCH", url: `/api/campaigns/${c.id}/budget`, status: 403 }]);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: c.id } })).dailyBudget).toBe(20_000);
    expect(updateBudget).not.toHaveBeenCalled();
    // Azaltma harcama yetkisi istemez (R2, düzenleme rolü yeterli).
    writes.length = 0;
    const down = await callAndConfirmOnScreen(runtime, "decrease_budget", { ref: "c1", dailyBudget: 150 });
    expect(down).toMatchObject({ ok: true, ref: "c1", dailyBudget: 150 });
    expect(writes).toEqual([{ method: "PATCH", url: `/api/campaigns/${c.id}/budget`, status: 200 }]);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: c.id } })).dailyBudget).toBe(15_000);
  });

  it("harcama yetkisi olmayan MEDIA_BUYER: BUDGET_INCREASE önerisini uygulama isteği 403", async () => {
    const c = await pausedCampaign();
    const draft = await prisma.studioDraft.create({
      data: { workspaceId, name: `Taslak ${suffix}`, content: {}, policy: { version: 1, risk: "LOW", findings: [] }, status: "APPROVED" },
    });
    const experiment = await prisma.studioExperiment.create({ data: { draftId: draft.id, snapshot: {}, metrics: [], status: "COMPLETED", elapsedDays: 7 } });
    const rec = await prisma.recommendation.create({
      data: {
        workspaceId,
        experimentId: experiment.id,
        type: "BUDGET_INCREASE",
        status: "APPROVED",
        title: "t",
        description: "d",
        reasoning: "r",
        action: { campaignId: c.id },
        expectedImpact: {},
      },
    });
    const { runtime } = runtimeAs("MEDIA_BUYER", c.id, rec.id);
    const out = await callAndConfirmOnScreen(runtime, "apply_recommendation", { ref: "r1" });
    expect(out).toEqual({ ok: false, error: TOOL_MESSAGES.spendForbidden, retryable: false });
    expect(writes).toEqual([{ method: "POST", url: `/api/recommendations/${rec.id}/apply`, status: 403 }]);
    expect((await prisma.recommendation.findUniqueOrThrow({ where: { id: rec.id } })).status).toBe("APPROVED");
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: c.id } })).dailyBudget).toBe(20_000);
  });

  it("OWNER: aylık tavanı aşan bütçe artışı ve etkinleştirme reddedilir (monthly_cap); tavan içindeki artış geçer", async () => {
    const c = await pausedCampaign();
    const { runtime } = runtimeAs("OWNER", c.id);
    // 1.001 × 30 = 30.030 > 30.000 (kuruluş sınırı).
    const over = await callAndConfirmOnScreen(runtime, "increase_budget", { ref: "c1", dailyBudget: 1001 });
    expect(over).toEqual({ ok: false, error: `${TOOL_MESSAGES.notApplicable}: monthly_cap`, retryable: false });
    expect(writes).toEqual([{ method: "PATCH", url: `/api/campaigns/${c.id}/budget`, status: 422 }]);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: c.id } })).dailyBudget).toBe(20_000);
    expect(updateBudget).not.toHaveBeenCalled();

    writes.length = 0;
    const within = await callAndConfirmOnScreen(runtime, "increase_budget", { ref: "c1", dailyBudget: 1000 });
    expect(within).toMatchObject({ ok: true, ref: "c1", dailyBudget: 1000 });
    expect(writes).toEqual([{ method: "PATCH", url: `/api/campaigns/${c.id}/budget`, status: 200 }]);
    expect(updateBudget).toHaveBeenCalledTimes(1);

    // Etkinleştirme: 2.000/gün × 30 = 60.000 > 30.000 → 422, Meta'ya gidilmez, kampanya duraklatılmış kalır.
    const big = await pausedCampaign(200_000);
    const second = runtimeAs("OWNER", big.id);
    writes.length = 0;
    const activate = await callAndConfirmOnScreen(second.runtime, "activate_campaign", { ref: "c1" });
    expect(activate).toEqual({ ok: false, error: `${TOOL_MESSAGES.notApplicable}: monthly_cap`, retryable: false });
    expect(writes).toEqual([{ method: "POST", url: `/api/campaigns/${big.id}/publish`, status: 422 }]);
    expect(setStatus).not.toHaveBeenCalled();
    expect(await prisma.campaign.findUniqueOrThrow({ where: { id: big.id } })).toMatchObject({ status: "PAUSED", workflowStatus: "PUBLISHED_PAUSED" });
  });
});

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { prisma, type Role } from "@admedic/database";
import { loadEnv } from "@admedic/config";
import { tokenHash } from "../app/_lib/password";
import { SESSION_COOKIE } from "../app/_lib/auth";
import { ApiError } from "../app/_lib/client-api";

// Sesli asistan Faz 5 (ADR-0028 §9): kuruluşun aylık dakika bütçesi ve günlük oturum sınırı gerçek veritabanıyla
// (oturum kimliğiyle bir kez kaydedilen VOICE_SESSION_ENDED ve aylık RequestQuota süre sayacı); A/B ölçüm aracının isteği gerçek uçlarda rol ve sürümle
// denetlenir (istemci rolü yanlış bildirse bile).

const { cookieJar } = vi.hoisted(() => ({ cookieJar: new Map<string, string>() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (key: string) => (cookieJar.has(key) ? { value: cookieJar.get(key) } : undefined),
    set: (key: string, value: string) => cookieJar.set(key, value),
    delete: (key: string) => cookieJar.delete(key),
  }),
}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

import { POST as sessionPost } from "../app/api/assistant/session/route";
import { POST as eventsPost } from "../app/api/assistant/events/route";
import { GET as experimentsGet } from "../app/api/experiments/route";
import { GET as experimentGet, PATCH as experimentPatch } from "../app/api/experiments/[id]/route";
import { VOICE_LIMIT_MESSAGES } from "../app/_lib/assistant/limits";
import { RefMap } from "../app/_lib/assistant/ref-map";
import { createToolRuntime, TOOL_MESSAGES } from "../app/_lib/assistant/runtime";

const ENV = {
  META_MOCK_MODE: "true",
  VOICE_ASSISTANT_ENABLED: "true",
  ELEVENLABS_ASSISTANT_AGENT_ID: "agent_integration_fake",
  VOICE_ASSISTANT_MAX_SESSION_SECONDS: "60",
  VOICE_ASSISTANT_DAILY_SESSIONS_PER_ORG: "0",
  VOICE_ASSISTANT_MONTHLY_MINUTES_PER_ORG: "2",
};

function useEnv(overrides: Record<string, string> = {}) {
  for (const [key, value] of Object.entries({ ...ENV, ...overrides })) vi.stubEnv(key, value);
  return loadEnv({ fresh: true });
}

describe.skipIf(process.env.STUDIO_DB_TEST !== "1")("sesli asistan sınırları ve A/B ölçüm aracı (ADR-0028 Faz 5)", () => {
  const suffix = randomBytes(8).toString("hex");
  const tokens: Partial<Record<Role, string>> = {};
  const userIds: string[] = [];
  let origin = "";
  let orgId = "";
  let workspaceId = "";

  const post = (path: string, data: unknown = {}) =>
    new Request(`${origin}${path}`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify(data),
    });
  const as = (role: Role) => cookieJar.set(SESSION_COOKIE, tokens[role]!);

  beforeAll(async () => {
    origin = new URL(useEnv().AUTH_URL).origin;
    const org = await prisma.organization.create({
      data: { name: "Voice limits fixture", slug: `voice-limits-${suffix}`, workspaces: { create: { name: "Voice", slug: "voice" } } },
      include: { workspaces: true },
    });
    orgId = org.id;
    workspaceId = org.workspaces[0]!.id;
    for (const role of ["OWNER", "MEDIA_BUYER", "ANALYST"] as Role[]) {
      const user = await prisma.user.create({ data: { email: `${suffix}-${role.toLowerCase()}@example.invalid` } });
      userIds.push(user.id);
      await prisma.membership.create({ data: { orgId, userId: user.id, role } });
      const token = randomBytes(32).toString("hex");
      await prisma.webSession.create({
        data: { tokenHash: tokenHash(token), userId: user.id, workspaceId, expiresAt: new Date(Date.now() + 600_000) },
      });
      tokens[role] = token;
    }
  });

  afterAll(async () => {
    cookieJar.clear();
    await prisma.requestQuota.deleteMany({
      where: {
        OR: [
          { key: { startsWith: `voice-org:${orgId}:` } },
          { key: { startsWith: `voice-minutes:${orgId}:` } },
          { key: { startsWith: `voice-session-ended:${orgId}:` } },
          ...userIds.flatMap((id) => [
            { key: { startsWith: `voice:${id}:` } },
            { key: { startsWith: `voice-event:${id}:` } },
            { key: { startsWith: `voice-session-end:${id}:` } },
          ]),
        ],
      },
    });
    await prisma.auditLog.deleteMany({ where: { orgId } });
    await prisma.organization.deleteMany({ where: { id: orgId } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    vi.unstubAllEnvs();
    loadEnv({ fresh: true });
    await prisma.$disconnect();
  });

  /** Oturum açar; açılış kaydını `secondsAgo` saniye geriye alır (duvar saati sınırı sınanabilsin). */
  async function openSession(secondsAgo: number): Promise<string> {
    const res = await sessionPost(post("/api/assistant/session"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { sessionRef: string; maxSessionSeconds: number };
    expect(json.maxSessionSeconds).toBe(60);
    const row = await prisma.auditLog.findFirstOrThrow({
      where: { orgId, action: "VOICE_SESSION_STARTED", after: { path: ["sessionRef"], equals: json.sessionRef } },
    });
    await prisma.auditLog.update({ where: { id: row.id }, data: { createdAt: new Date(Date.now() - secondsAgo * 1000) } });
    return json.sessionRef;
  }
  const ended = (sessionRef: string, durationSeconds: number, conversationId?: string) =>
    eventsPost(post("/api/assistant/events", { type: "session_ended", sessionRef, durationSeconds, ...(conversationId ? { conversationId } : {}) }));

  it("aylık dakika bütçesi: oturum kimliğiyle bir kez kaydedilen süreler (kırpılmış) toplanır; bütçe dolunca yeni oturum 429", async () => {
    useEnv();
    as("OWNER");
    // Oturum açılmadan bildirilen süre kabul edilmez.
    expect((await ended("f".repeat(32), 60)).status).toBe(404);
    // 60 sn sınırında 9 999 sn bildirimi 90 sn (60 + 30) sayılır; oturum 120 sn önce açıldı.
    const first = await openSession(120);
    expect((await ended(first, 9_999, "conv_int_1")).status).toBe(200);
    // Aynı oturum ikinci kez sayılmaz.
    expect((await ended(first, 60)).status).toBe(409);
    // Başka kullanıcı bu oturumu kapatamaz.
    as("ANALYST");
    const second = await openSession(30);
    expect((await ended(first, 60)).status).toBe(404);
    // 30 sn önce açılan oturum için 45 sn bildirimi 30 sn sayılır (duvar saati).
    expect((await ended(second, 45)).status).toBe(200);
    const rows = await prisma.auditLog.findMany({ where: { orgId, action: "VOICE_SESSION_ENDED" }, orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => (r.after as { durationSeconds: number }).durationSeconds)).toEqual([90, expect.any(Number)]);
    const secondSeconds = (rows[1]!.after as { durationSeconds: number }).durationSeconds;
    expect(secondSeconds).toBeGreaterThanOrEqual(30);
    expect(secondSeconds).toBeLessThanOrEqual(32);
    expect(rows.map((r) => r.entityId)).toEqual(["conv_int_1", null]);
    const counter = await prisma.requestQuota.findFirst({ where: { key: { startsWith: `voice-minutes:${orgId}:` } } });
    expect(counter?.count).toBe(90 + secondSeconds);
    // 120+ sn ≥ 2 dk: reddedilir; konuşma metni hiçbir satırda yok.
    const refused = await sessionPost(post("/api/assistant/session"));
    expect(refused.status).toBe(429);
    expect((await refused.json()).error).toBe(VOICE_LIMIT_MESSAGES.monthlyMinutes);
    expect(await prisma.auditLog.count({ where: { orgId, action: "VOICE_SESSION_STARTED" } })).toBe(2);
  });

  it("günlük oturum sınırı kuruluş başınadır: kullanıcılar ortak sayacı tüketir, aşılınca 429", async () => {
    useEnv({ VOICE_ASSISTANT_MONTHLY_MINUTES_PER_ORG: "0", VOICE_ASSISTANT_DAILY_SESSIONS_PER_ORG: "2" });
    as("MEDIA_BUYER");
    expect((await sessionPost(post("/api/assistant/session"))).status).toBe(200);
    as("ANALYST");
    expect((await sessionPost(post("/api/assistant/session"))).status).toBe(200);
    const refused = await sessionPost(post("/api/assistant/session"));
    expect(refused.status).toBe(429);
    expect((await refused.json()).error).toBe(VOICE_LIMIT_MESSAGES.dailySessions);
    const counter = await prisma.requestQuota.findFirst({ where: { key: { startsWith: `voice-org:${orgId}:` } } });
    expect(counter?.count).toBe(3);
  });

  describe("update_experiment_metrics gerçek uçlarla", () => {
    type Handler = (request: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
    const ROUTES: { method: string; pattern: RegExp; handler: Handler }[] = [
      { method: "GET", pattern: /^\/api\/experiments$/, handler: () => experimentsGet() },
      { method: "GET", pattern: /^\/api\/experiments\/([^/]+)$/, handler: experimentGet },
      { method: "PATCH", pattern: /^\/api\/experiments\/([^/]+)$/, handler: experimentPatch },
    ];
    async function routeApi<T>(url: string, method = "GET", data?: unknown): Promise<T> {
      const route = ROUTES.find((r) => r.method === method && r.pattern.test(url));
      if (!route) throw new Error(`Testte bağlanmamış uç: ${method} ${url}`);
      const id = decodeURIComponent(route.pattern.exec(url)![1] ?? "");
      const response = await route.handler(
        new Request(`${origin}${url}`, {
          method,
          headers: { origin, ...(data === undefined ? {} : { "content-type": "application/json" }) },
          body: data === undefined ? undefined : JSON.stringify(data),
        }),
        { params: Promise.resolve({ id }) },
      );
      const result = (await response.json()) as { error?: string };
      if (!response.ok) throw new ApiError(result.error ?? "", response.status);
      return result as T;
    }

    async function experiment() {
      const snapshot = { clinic: "Sahte Klinik", service: "Saç ekimi", market: "DE", language: "DE", duration: 7, budget: 700,
        variants: [{ headline: "A", text: "Metin", cta: "Bilgi al" }, { headline: "B", text: "Metin", cta: "Bilgi al" }] };
      const draft = await prisma.studioDraft.create({
        data: { workspaceId, name: `Taslak ${randomBytes(3).toString("hex")}`, content: snapshot, policy: { version: 1, risk: "LOW", findings: [] }, status: "APPROVED" },
      });
      return prisma.studioExperiment.create({
        data: { draftId: draft.id, snapshot, metrics: [{ spend: 10, clicks: 20, leads: 2 }, { spend: 5, clicks: 10, leads: 1 }], status: "RUNNING", elapsedDays: 2 },
      });
    }

    /** İstemci rolü bilerek OWNER bildirir: ön süzgeç atlanır, karar sunucudadır. */
    async function prepareAndConfirm(role: Role) {
      as(role);
      const runtime = createToolRuntime({ role: "OWNER", canApproveSpend: false, router: { push: () => undefined }, api: routeApi, refs: new RefMap(), reportEvent: () => undefined, pending: { timers: false } });
      const list = JSON.parse(await runtime.clientTools.list_experiments!({ status: "RUNNING" })) as { experiments: { ref: string }[] };
      const ref = list.experiments[0]!.ref;
      const prepared = JSON.parse(await runtime.clientTools.update_experiment_metrics!({ ref, variant: "B", spend: 50, clicks: 100, leads: 9, elapsedDays: 3 })) as Record<string, unknown>;
      expect(prepared.status, JSON.stringify(prepared)).toBe("awaiting_confirmation");
      runtime.noteUserTurn("evet");
      return JSON.parse(await runtime.clientTools.confirm_pending_action!({ pendingId: prepared.pendingId })) as Record<string, unknown>;
    }

    it("analist: PATCH sunucuda 403; deney değişmez", async () => {
      const exp = await experiment();
      expect(await prepareAndConfirm("ANALYST")).toEqual({ ok: false, error: TOOL_MESSAGES.forbidden, retryable: false });
      const after = await prisma.studioExperiment.findUniqueOrThrow({ where: { id: exp.id } });
      expect(after.version).toBe(1);
      expect(after.metrics).toEqual(exp.metrics);
      await prisma.studioDraft.delete({ where: { id: exp.draftId } });
    });

    it("medya alıcısı: tek yazma; diğer varyant korunur, sürüm artar, denetim kaydı ucun kendisinde", async () => {
      const exp = await experiment();
      const out = await prepareAndConfirm("MEDIA_BUYER");
      expect(out, JSON.stringify(out)).toMatchObject({ ok: true, variant: "B", elapsedDays: 3 });
      const after = await prisma.studioExperiment.findUniqueOrThrow({ where: { id: exp.id } });
      expect(after.version).toBe(2);
      expect(after.status).toBe("RUNNING");
      expect(after.elapsedDays).toBe(3);
      expect(after.metrics).toEqual([{ spend: 10, clicks: 20, leads: 2 }, { spend: 50, clicks: 100, leads: 9 }]);
      expect(await prisma.auditLog.count({ where: { orgId, action: "EXPERIMENT_UPDATED", entityId: exp.id } })).toBe(1);
    });
  });
});

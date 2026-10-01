import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "@admedic/config";

// Sesli asistan uçları (ADR-0028): veritabanı yerine sahte Prisma istemcisi, ortam yerine test başına değiştirilen
// yapılandırma. Oturum çerezi, `studio-session` biçiminde (64 hex) sahte bir belirteçtir.
const state = vi.hoisted(() => ({
  env: undefined as unknown as AppEnv,
  cookies: new Map<string, string>(),
  quotaCount: 1,
  role: "MEDIA_BUYER",
  canApproveSpend: false,
}));
const db = vi.hoisted(() => ({
  webSession: { findUnique: vi.fn() },
  membership: { findUnique: vi.fn() },
  requestQuota: { upsert: vi.fn() },
  auditLog: { create: vi.fn() },
}));
vi.mock("@admedic/database", () => ({ prisma: db, Prisma: { DbNull: null } }));
vi.mock("@admedic/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@admedic/config")>()),
  loadEnv: () => state.env,
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (key: string) => (state.cookies.has(key) ? { value: state.cookies.get(key) } : undefined),
  }),
}));

const { loadEnv: realLoadEnv } = await vi.importActual<typeof import("@admedic/config")>("@admedic/config");
const { POST: startSession } = await import("../app/api/assistant/session/route");
const { POST: logEvent } = await import("../app/api/assistant/events/route");
const { POST: planCampaign } = await import("../app/api/campaign-planner/route");

const ORIGIN = "http://localhost:3000";
const API_KEY = "sk_test_never_leak_0123456789";
const AGENT_ID = "agent_secret_id_abc";
const TOKEN = "a".repeat(64);

const post = (path: string, data: unknown = {}, origin: string | null = ORIGIN) =>
  new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
    body: JSON.stringify(data),
  });

function setEnv(overrides: Record<string, string | undefined> = {}) {
  state.env = realLoadEnv({
    fresh: true,
    overrides: {
      NODE_ENV: "test",
      AUTH_URL: ORIGIN,
      APP_NAME: "TestUygulama",
      ASSISTANT_NAME: undefined,
      META_MOCK_MODE: "true",
      VOICE_ASSISTANT_ENABLED: "true",
      ELEVENLABS_API_KEY: API_KEY,
      ELEVENLABS_ASSISTANT_AGENT_ID: AGENT_ID,
      ELEVENLABS_ASSISTANT_CONNECTION: "webrtc",
      ELEVENLABS_SERVER_LOCATION: "us",
      ELEVENLABS_API_BASE: "https://api.elevenlabs.io",
      ...overrides,
    },
  });
}

const fetchSpy = vi.fn();

beforeEach(() => {
  for (const model of Object.values(db)) for (const fn of Object.values(model)) fn.mockReset();
  setEnv();
  state.cookies.clear();
  state.cookies.set("studio-session", TOKEN);
  state.quotaCount = 1;
  state.role = "MEDIA_BUYER";
  state.canApproveSpend = false;
  db.webSession.findUnique.mockResolvedValue({
    userId: "user-1",
    workspaceId: "ws-1",
    expiresAt: new Date(Date.now() + 3600_000),
    workspace: { orgId: "org-1", name: "Çalışma" },
  });
  db.membership.findUnique.mockImplementation(({ select }: { select?: unknown }) =>
    Promise.resolve(
      select
        ? { role: state.role, status: "ACTIVE", canApproveSpend: state.canApproveSpend }
        : { userId: "user-1", orgId: "org-1", role: state.role, status: "ACTIVE" },
    ),
  );
  db.requestQuota.upsert.mockImplementation(() => Promise.resolve({ count: state.quotaCount }));
  db.auditLog.create.mockResolvedValue({});
  fetchSpy.mockReset();
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /api/assistant/session", () => {
  it("bayrak kapalıysa ya da ajan tanımlı değilse 404; oturuma ve kotaya bakılmaz", async () => {
    setEnv({ VOICE_ASSISTANT_ENABLED: "false" });
    expect((await startSession(post("/api/assistant/session"))).status).toBe(404);
    setEnv({ ELEVENLABS_ASSISTANT_AGENT_ID: undefined });
    expect((await startSession(post("/api/assistant/session"))).status).toBe(404);
    expect(db.webSession.findUnique).not.toHaveBeenCalled();
    expect(db.requestQuota.upsert).not.toHaveBeenCalled();
  });

  it("oturum yoksa 401, kaynak yabancıysa 403", async () => {
    state.cookies.clear();
    expect((await startSession(post("/api/assistant/session"))).status).toBe(401);
    state.cookies.set("studio-session", TOKEN);
    expect((await startSession(post("/api/assistant/session", {}, "https://evil.example"))).status).toBe(403);
    expect((await startSession(post("/api/assistant/session", {}, null))).status).toBe(403);
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it("kullanıcı başına saatte 20 oturum; aşılınca 429 ve belirteç alınmaz", async () => {
    state.quotaCount = 21;
    const res = await startSession(post("/api/assistant/session"));
    expect(res.status).toBe(429);
    expect(db.requestQuota.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { key: expect.stringMatching(/^voice:user-1:\d+$/) } }),
    );
    const window = db.requestQuota.upsert.mock.calls[0][0].create.expiresAt.getTime() - Date.now();
    expect(window).toBeLessThanOrEqual(3600_000);
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it("deneme modunda dış istek yapmaz; ad APP_NAME'den, dil çerezden gelir; denetim kaydı yazılır", async () => {
    state.cookies.set("ui-lang", "en");
    const res = await startSession(post("/api/assistant/session"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(json).toMatchObject({
      connection: "webrtc",
      conversationToken: "mock_assistant_token",
      serverLocation: "us",
      mock: true,
      assistantName: "TestUygulama",
      language: "en",
      role: "MEDIA_BUYER",
      canApproveSpend: false,
    });
    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orgId: "org-1",
        workspaceId: "ws-1",
        userId: "user-1",
        action: "VOICE_SESSION_STARTED",
        entityType: "VOICE_ASSISTANT",
      }),
    });
  });

  it("canlı modda belirteç döner; yanıtta API anahtarı ve ajan kimliği yoktur", async () => {
    setEnv({ META_MOCK_MODE: "false", ASSISTANT_NAME: "Asistan" });
    fetchSpy.mockResolvedValue(Response.json({ token: "rtc_token_1", conversation_id: "conv_1" }));
    const res = await startSession(post("/api/assistant/session"));
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain(API_KEY);
    expect(raw).not.toContain(AGENT_ID);
    expect(JSON.parse(raw)).toMatchObject({
      connection: "webrtc",
      conversationToken: "rtc_token_1",
      conversationId: "conv_1",
      mock: false,
      assistantName: "Asistan",
      language: "tr",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toContain("/v1/convai/conversation/token");
  });

  it("websocket yapılandırmasında imzalı URL döner", async () => {
    setEnv({ META_MOCK_MODE: "false", ELEVENLABS_ASSISTANT_CONNECTION: "websocket" });
    fetchSpy.mockResolvedValue(Response.json({ signed_url: "wss://api.elevenlabs.io/v1/convai/x?token=t" }));
    const json = await (await startSession(post("/api/assistant/session"))).json();
    expect(json).toMatchObject({ connection: "websocket", signedUrl: "wss://api.elevenlabs.io/v1/convai/x?token=t" });
    expect(json).not.toHaveProperty("conversationToken");
  });

  it("sağlayıcı hatası anahtarı ya da yanıt gövdesini sızdırmaz", async () => {
    setEnv({ META_MOCK_MODE: "false" });
    fetchSpy.mockResolvedValue(new Response(`invalid key ${API_KEY}`, { status: 401 }));
    const res = await startSession(post("/api/assistant/session"));
    expect(res.status).toBeGreaterThanOrEqual(400);
    const raw = await res.text();
    expect(raw).not.toContain(API_KEY);
    expect(raw).not.toContain(AGENT_ID);
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });
});

describe("POST /api/assistant/events", () => {
  const toolCall = { type: "tool_call", tool: "list_campaigns", risk: "R0", outcome: "ok", conversationId: "conv_1" };

  it("bayrak kapalıysa ya da ajan tanımlı değilse 404, oturum yoksa 401, kaynak yabancıysa 403", async () => {
    setEnv({ VOICE_ASSISTANT_ENABLED: "false" });
    expect((await logEvent(post("/api/assistant/events", toolCall))).status).toBe(404);
    setEnv({ ELEVENLABS_ASSISTANT_AGENT_ID: undefined });
    expect((await logEvent(post("/api/assistant/events", toolCall))).status).toBe(404);
    setEnv();
    state.cookies.clear();
    expect((await logEvent(post("/api/assistant/events", toolCall))).status).toBe(401);
    state.cookies.set("studio-session", TOKEN);
    expect((await logEvent(post("/api/assistant/events", toolCall, "https://evil.example"))).status).toBe(403);
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it("kullanıcı başına dakikada 30 olay; aşılınca 429", async () => {
    state.quotaCount = 31;
    expect((await logEvent(post("/api/assistant/events", toolCall))).status).toBe(429);
    expect(db.requestQuota.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { key: expect.stringMatching(/^voice-event:user-1:\d+$/) } }),
    );
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it("araç çağrısını ve onayı yalnızca izinli alanlarla kaydeder", async () => {
    expect((await logEvent(post("/api/assistant/events", { ...toolCall, entityRef: "c3" }))).status).toBe(200);
    expect(db.auditLog.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({
        action: "VOICE_TOOL_CALL",
        entityType: "VOICE_ASSISTANT",
        entityId: "c3",
        after: { tool: "list_campaigns", risk: "R0", outcome: "ok", source: "client", conversationId: "conv_1" },
      }),
    });
    expect((await logEvent(post("/api/assistant/events", { type: "consent_given" }))).status).toBe(200);
    expect(db.auditLog.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({ action: "VOICE_CONSENT_GIVEN", entityId: null }),
    });
  });

  it("bilinmeyen alanı (transkript), serbest metni ve eksik/uyumsuz alanları reddeder", async () => {
    const bad: unknown[] = [
      { ...toolCall, transcript: "Ayşe Yılmaz'ın kampanyasını aç" },
      { ...toolCall, text: "merhaba" },
      { ...toolCall, args: { name: "x" } },
      { ...toolCall, entityRef: "Ayşe Yılmaz" },
      { ...toolCall, tool: "List Campaigns" },
      { ...toolCall, risk: "R4" },
      { ...toolCall, outcome: "maybe" },
      { type: "tool_call", tool: "list_campaigns" },
      { type: "consent_given", tool: "list_campaigns" },
      { type: "other" },
    ];
    for (const data of bad) expect((await logEvent(post("/api/assistant/events", data))).status, JSON.stringify(data)).toBe(400);
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it("rolün çalıştıramayacağı risk seviyesi kaydedilmez (403)", async () => {
    const at = (risk: string) => logEvent(post("/api/assistant/events", { ...toolCall, tool: "some_tool", risk }));
    state.role = "VIEWER";
    expect((await at("R0")).status).toBe(200);
    expect((await at("R1")).status).toBe(403);
    state.role = "ANALYST";
    expect((await at("R1")).status).toBe(200);
    expect((await at("R2")).status).toBe(403);
    state.role = "MEDIA_BUYER";
    expect((await at("R2")).status).toBe(200);
    expect((await at("R3")).status).toBe(403);
    state.canApproveSpend = true;
    expect((await at("R3")).status).toBe(200);
    state.role = "OWNER";
    state.canApproveSpend = false;
    expect((await at("R3")).status).toBe(200);
    expect(db.auditLog.create).toHaveBeenCalledTimes(5);
  });

  it("büyük gövde 413 ile reddedilir", async () => {
    const res = await logEvent(post("/api/assistant/events", { ...toolCall, conversationId: "x".repeat(4000) }));
    expect(res.status).toBe(413);
  });
});

// Faz 0 rol doğrulaması: `plan_campaign` aracının kaynağı. Planlayıcı düzenleme ekranıdır; düzenleme rolü
// olmayanlar aylık tavandan kalan payı hesaplatamaz (studio/[id] ve experiments/[id] rolü studio-service'te denetler).
describe("POST /api/campaign-planner (rol)", () => {
  const plan = { objective: "MAX_CONVERSIONS", dailyBudgetCents: 20_000, markets: ["TR"] };

  it("düzenleme rolü olmayanlar 403 alır; veri okunmaz", async () => {
    for (const role of ["VIEWER", "ANALYST", "PATIENT_COORDINATOR"]) {
      state.role = role;
      expect((await planCampaign(post("/api/campaign-planner", plan))).status, role).toBe(403);
    }
  });
});

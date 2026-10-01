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
  requestQuota: { upsert: vi.fn(), create: vi.fn(), findUnique: vi.fn() },
  auditLog: { create: vi.fn(), findMany: vi.fn(), findFirst: vi.fn() },
  $transaction: vi.fn(),
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
const { VOICE_LIMIT_MESSAGES } = await import("../app/_lib/assistant/limits");

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
  for (const [name, model] of Object.entries(db)) if (name !== "$transaction") for (const fn of Object.values(model)) fn.mockReset();
  db.$transaction.mockReset();
  // Etkileşimli işlem: aynı sahte istemciyle çalışır.
  db.$transaction.mockImplementation((fn: (tx: typeof db) => Promise<unknown>) => fn(db));
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
  db.auditLog.findMany.mockResolvedValue([]);
  db.auditLog.findFirst.mockResolvedValue(null);
  db.requestQuota.create.mockResolvedValue({});
  db.requestQuota.findUnique.mockResolvedValue(null);
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

  it("rolün bağlayamayacağı araç için ok/error/cancelled kaydedilmez (403)", async () => {
    const r0 = () => logEvent(post("/api/assistant/events", { ...toolCall, tool: "list_campaigns", risk: "R0" }));
    const r1 = () => logEvent(post("/api/assistant/events", { ...toolCall, tool: "update_alert", risk: "R1", outcome: "cancelled" }));
    state.role = "VIEWER";
    expect((await r0()).status).toBe(200);
    expect((await r1()).status).toBe(403);
    // Faz 4: aracın rol listesi de denetlenir (analist uyarı kapatamaz; `update_alert` ona hiç bağlanmaz).
    state.role = "ANALYST";
    expect((await r1()).status).toBe(403);
    state.role = "PATIENT_COORDINATOR";
    expect((await r1()).status).toBe(200);
    state.role = "MEDIA_BUYER";
    expect((await r1()).status).toBe(200);
    expect(db.auditLog.create).toHaveBeenCalledTimes(3);
    expect(db.auditLog.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({
        action: "VOICE_TOOL_CALL",
        after: { tool: "update_alert", risk: "R1", outcome: "cancelled", source: "client", conversationId: "conv_1" },
      }),
    });
  });

  it("araç adı kayıtta olmalı ve risk kayıttakiyle aynı olmalı (400)", async () => {
    state.role = "OWNER";
    state.canApproveSpend = true;
    const bad: unknown[] = [
      { ...toolCall, tool: "some_tool" },
      { ...toolCall, tool: "approve_campaign", risk: "R0" },
      // Kayıttaki risk küçültülerek ya da büyütülerek bildirilemez.
      { ...toolCall, tool: "update_alert", risk: "R0" },
      { ...toolCall, tool: "list_campaigns", risk: "R1" },
      { ...toolCall, tool: "create_campaign_draft", risk: "R3" },
      // Faz 4: R2/R3 araçları kayıtta; riskleri yine küçültülemez/büyütülemez (yetkisiz denemede de).
      { ...toolCall, tool: "activate_campaign", risk: "R2" },
      { ...toolCall, tool: "increase_budget", risk: "R2", outcome: "denied" },
      { ...toolCall, tool: "publish_campaign_paused", risk: "R3" },
      { ...toolCall, tool: "update_lead_status", risk: "R1" },
      // R4 işlemleri araç değildir: "denied" olarak da kaydedilemez.
      { ...toolCall, tool: "approve_campaign", risk: "R3", outcome: "denied" },
    ];
    for (const data of bad) expect((await logEvent(post("/api/assistant/events", data))).status, JSON.stringify(data)).toBe(400);
    expect(db.auditLog.create).not.toHaveBeenCalled();
    expect((await logEvent(post("/api/assistant/events", { ...toolCall, tool: "confirm_pending_action", risk: "R0", outcome: "denied" }))).status).toBe(200);
  });

  it("Faz 4: yetkisiz denemeler 'denied' olarak her rolde kaydedilir; ok/error/cancelled yalnızca bağlanabilen araçta", async () => {
    const event = (tool: string, risk: string, outcome: string) => logEvent(post("/api/assistant/events", { ...toolCall, tool, risk, outcome }));
    // İzleyici: R1/R2/R3 denemesi denetime düşer (Faz 3'ün açık maddesi), ama "ok" kaydedilemez.
    state.role = "VIEWER";
    expect((await event("update_alert", "R1", "denied")).status).toBe(200);
    expect((await event("pause_campaign", "R2", "denied")).status).toBe(200);
    expect((await event("activate_campaign", "R3", "denied")).status).toBe(200);
    expect((await event("pause_campaign", "R2", "ok")).status).toBe(403);
    expect((await event("update_alert", "R1", "error")).status).toBe(403);
    // Hasta koordinatörü: R2'de yalnızca lead durumu; kampanya R2 aracı ok/cancelled kaydedemez.
    state.role = "PATIENT_COORDINATOR";
    expect((await event("update_lead_status", "R2", "ok")).status).toBe(200);
    expect((await event("pause_campaign", "R2", "cancelled")).status).toBe(403);
    expect((await event("pause_campaign", "R2", "denied")).status).toBe(200);
    // Harcama yetkisi olmayan medya alıcısı: R2 ok, R3 yalnızca denied (yetki sunucuda taze okunur).
    state.role = "MEDIA_BUYER";
    state.canApproveSpend = false;
    expect((await event("decrease_budget", "R2", "ok")).status).toBe(200);
    expect((await event("increase_budget", "R3", "ok")).status).toBe(403);
    expect((await event("increase_budget", "R3", "denied")).status).toBe(200);
    state.canApproveSpend = true;
    expect((await event("increase_budget", "R3", "ok")).status).toBe(200);
    expect(db.auditLog.create).toHaveBeenCalledTimes(8);
    expect(db.auditLog.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({
        action: "VOICE_TOOL_CALL",
        after: { tool: "increase_budget", risk: "R3", outcome: "ok", source: "client", conversationId: "conv_1" },
      }),
    });
  });

  it("büyük gövde 413 ile reddedilir", async () => {
    const res = await logEvent(post("/api/assistant/events", { ...toolCall, conversationId: "x".repeat(4000) }));
    expect(res.status).toBe(413);
  });
});

// Faz 5: kuruluş başına günlük oturum sınırı, aylık dakika bütçesi ve oturum sonu kaydı.
describe("sesli asistan sınırları (Faz 5)", () => {
  /** `quota()` anahtara göre sayaç: kullanıcı anahtarı 1, kuruluş anahtarı `orgCount`. */
  function quotaCounts(orgCount: number) {
    db.requestQuota.upsert.mockImplementation(({ where }: { where: { key: string } }) =>
      Promise.resolve({ count: where.key.startsWith("voice-org:") ? orgCount : 1 }),
    );
  }

  it("oturum yanıtı en uzun süreyi taşır (varsayılan 300 sn, ortamdan ayarlanır)", async () => {
    expect((await (await startSession(post("/api/assistant/session"))).json()).maxSessionSeconds).toBe(300);
    setEnv({ VOICE_ASSISTANT_MAX_SESSION_SECONDS: "120" });
    expect((await (await startSession(post("/api/assistant/session"))).json()).maxSessionSeconds).toBe(120);
  });

  it("kuruluş başına günlük oturum sınırı: aşılınca 429 ve Türkçe ileti; belirteç ve denetim kaydı yok", async () => {
    setEnv({ VOICE_ASSISTANT_DAILY_SESSIONS_PER_ORG: "3" });
    quotaCounts(3);
    expect((await startSession(post("/api/assistant/session"))).status).toBe(200);
    const orgCall = db.requestQuota.upsert.mock.calls.find((c) => String(c[0].where.key).startsWith("voice-org:"));
    expect(orgCall?.[0].where.key).toMatch(/^voice-org:org-1:\d+$/);
    // Gün penceresi (86 400 sn).
    expect(orgCall![0].create.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(86_400_000);
    db.auditLog.create.mockClear();
    quotaCounts(4);
    const res = await startSession(post("/api/assistant/session"));
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe(VOICE_LIMIT_MESSAGES.dailySessions);
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it("günlük sınır 0 iken kuruluş sayacı hiç kullanılmaz (sınırsız)", async () => {
    setEnv({ VOICE_ASSISTANT_DAILY_SESSIONS_PER_ORG: "0" });
    quotaCounts(1_000_000);
    expect((await startSession(post("/api/assistant/session"))).status).toBe(200);
    expect(db.requestQuota.upsert.mock.calls.every((c) => !String(c[0].where.key).startsWith("voice-org:"))).toBe(true);
  });

  it("aylık dakika bütçesi: bu ayın süre sayacı bütçeye ulaşınca 429; denetim kaydı taranmaz, günlük sayaç tüketilmez", async () => {
    setEnv({ VOICE_ASSISTANT_MONTHLY_MINUTES_PER_ORG: "10" });
    db.requestQuota.findUnique.mockResolvedValue({ count: 599 });
    expect((await startSession(post("/api/assistant/session"))).status).toBe(200);
    const now = new Date();
    const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    expect(db.requestQuota.findUnique.mock.calls[0][0].where).toEqual({ key: `voice-minutes:org-1:${month}` });
    expect(db.auditLog.findMany).not.toHaveBeenCalled();

    db.requestQuota.findUnique.mockResolvedValue({ count: 600 });
    db.requestQuota.upsert.mockClear();
    db.auditLog.create.mockClear();
    const res = await startSession(post("/api/assistant/session"));
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe(VOICE_LIMIT_MESSAGES.monthlyMinutes);
    expect(db.requestQuota.upsert.mock.calls.some((c) => String(c[0].where.key).startsWith("voice-org:"))).toBe(false);
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it("aylık bütçe 0 iken sayaç okunmaz", async () => {
    expect((await startSession(post("/api/assistant/session"))).status).toBe(200);
    expect(db.requestQuota.findUnique).not.toHaveBeenCalled();
  });

  it("oturum yanıtı sunucunun ürettiği oturum kimliğini taşır; açılış kaydına da yazılır", async () => {
    const res = await (await startSession(post("/api/assistant/session"))).json();
    expect(res.sessionRef).toMatch(/^[a-f0-9]{32}$/);
    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "VOICE_SESSION_STARTED", after: expect.objectContaining({ sessionRef: res.sessionRef }) }),
    });
    const again = await (await startSession(post("/api/assistant/session"))).json();
    expect(again.sessionRef).not.toBe(res.sessionRef);
  });

  const REF = "f".repeat(32);
  /** Açılış kaydı `secondsAgo` saniye önce yazılmış gibi. */
  const startedAgo = (secondsAgo: number) =>
    db.auditLog.findFirst.mockResolvedValue({ createdAt: new Date(Date.now() - secondsAgo * 1000) });

  it("session_ended: oturum kimliği aynı kullanıcının açılış kaydında aranır; süre max + 30 ve geçen süreyle kırpılır", async () => {
    setEnv({ VOICE_ASSISTANT_MAX_SESSION_SECONDS: "300" });
    startedAgo(200);
    const ended = { type: "session_ended", sessionRef: REF, durationSeconds: 125, conversationId: "conv_1" };
    expect((await logEvent(post("/api/assistant/events", ended))).status).toBe(200);
    const where = db.auditLog.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({
      orgId: "org-1",
      userId: "user-1",
      action: "VOICE_SESSION_STARTED",
      after: { path: ["sessionRef"], equals: REF },
    });
    // Arama penceresi: en uzun süre + 1 saat.
    expect(Date.now() - where.createdAt.gte.getTime()).toBeGreaterThanOrEqual((300 + 3600) * 1000);
    expect(Date.now() - where.createdAt.gte.getTime()).toBeLessThan((300 + 3600 + 5) * 1000);
    expect(db.requestQuota.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ key: `voice-session-ended:org-1:${REF}`, count: 1 }),
    });
    expect(db.requestQuota.upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { key: expect.stringMatching(/^voice-minutes:org-1:\d{4}-\d{2}$/) },
        create: expect.objectContaining({ count: 125 }),
        update: { count: { increment: 125 } },
      }),
    );
    expect(db.auditLog.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({
        action: "VOICE_SESSION_ENDED",
        entityType: "VOICE_ASSISTANT",
        entityId: "conv_1",
        after: { durationSeconds: 125, source: "client", sessionRef: REF },
      }),
    });

    // Bildirilen 7 200 sn: en uzun süre + 30 = 330 sn'ye kırpılır (oturum 1 saat önce açıldı).
    startedAgo(3600);
    expect((await logEvent(post("/api/assistant/events", { type: "session_ended", sessionRef: REF, durationSeconds: 7200 }))).status).toBe(200);
    expect(db.auditLog.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({ entityId: null, after: { durationSeconds: 330, source: "client", sessionRef: REF } }),
    });

    // Oturum 40 sn önce açıldıysa 300 sn bildirimi 40 sn sayılır (duvar saati).
    startedAgo(40);
    expect((await logEvent(post("/api/assistant/events", { type: "session_ended", sessionRef: REF, durationSeconds: 300 }))).status).toBe(200);
    // Saniye yukarı yuvarlanır; test süresi bir saniyeyi aşarsa 41 olabilir.
    const after = db.auditLog.create.mock.lastCall![0].data.after as { durationSeconds: number };
    expect(after.durationSeconds).toBeGreaterThanOrEqual(40);
    expect(after.durationSeconds).toBeLessThanOrEqual(41);
  });

  it("session_ended: bilinmeyen (ya da başka kullanıcının) oturumu 404; sayaç ve kayıt yazılmaz", async () => {
    state.role = "VIEWER";
    const res = await logEvent(post("/api/assistant/events", { type: "session_ended", sessionRef: REF, durationSeconds: 300 }));
    expect(res.status).toBe(404);
    expect(db.requestQuota.create).not.toHaveBeenCalled();
    expect(db.requestQuota.upsert.mock.calls.some((c) => String(c[0].where.key).startsWith("voice-minutes:"))).toBe(false);
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it("session_ended: aynı oturumun ikinci bildirimi 409; sayaç ikinci kez artmaz", async () => {
    startedAgo(60);
    db.requestQuota.create.mockRejectedValue(Object.assign(new Error("Unique constraint failed"), { code: "P2002" }));
    const res = await logEvent(post("/api/assistant/events", { type: "session_ended", sessionRef: REF, durationSeconds: 60 }));
    expect(res.status).toBe(409);
    expect(db.requestQuota.upsert.mock.calls.some((c) => String(c[0].where.key).startsWith("voice-minutes:"))).toBe(false);
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it("session_ended kendi hız sınırını kullanır (dakikada 10); araç olaylarının sınırı onu düşürmez", async () => {
    startedAgo(60);
    db.requestQuota.upsert.mockImplementation(({ where }: { where: { key: string } }) =>
      Promise.resolve({ count: where.key.startsWith("voice-event:") ? 31 : 1 }),
    );
    expect((await logEvent(post("/api/assistant/events", { type: "tool_call", tool: "list_campaigns", risk: "R0", outcome: "ok" }))).status).toBe(429);
    expect((await logEvent(post("/api/assistant/events", { type: "session_ended", sessionRef: REF, durationSeconds: 60 }))).status).toBe(200);
    expect(db.requestQuota.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { key: expect.stringMatching(/^voice-session-end:user-1:\d+$/) } }),
    );
    db.requestQuota.upsert.mockImplementation(({ where }: { where: { key: string } }) =>
      Promise.resolve({ count: where.key.startsWith("voice-session-end:") ? 11 : 1 }),
    );
    db.auditLog.create.mockClear();
    expect((await logEvent(post("/api/assistant/events", { type: "session_ended", sessionRef: REF, durationSeconds: 60 }))).status).toBe(429);
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it("session_ended şeması sıkı: oturum kimliği ve süre zorunlu, tam sayı, en çok bir gün; metin ve araç alanı yok", async () => {
    const sessionRef = REF;
    const bad: unknown[] = [
      { type: "session_ended", sessionRef },
      { type: "session_ended", durationSeconds: 60 },
      { type: "session_ended", sessionRef: "bad ref", durationSeconds: 60 },
      { type: "session_ended", sessionRef, durationSeconds: -1 },
      { type: "session_ended", sessionRef, durationSeconds: 12.5 },
      { type: "session_ended", sessionRef, durationSeconds: "60" },
      { type: "session_ended", sessionRef, durationSeconds: 86_401 },
      { type: "session_ended", sessionRef, durationSeconds: 60, transcript: "Ayşe Yılmaz" },
      { type: "session_ended", sessionRef, durationSeconds: 60, tool: "list_campaigns" },
      { type: "session_ended", sessionRef, durationSeconds: 60, outcome: "ok" },
      { type: "tool_call", tool: "list_campaigns", risk: "R0", outcome: "ok", durationSeconds: 60 },
      { type: "tool_call", tool: "list_campaigns", risk: "R0", outcome: "ok", sessionRef },
      { type: "consent_given", durationSeconds: 60 },
      { type: "consent_given", sessionRef },
    ];
    for (const data of bad) expect((await logEvent(post("/api/assistant/events", data))).status, JSON.stringify(data)).toBe(400);
    expect(db.auditLog.create).not.toHaveBeenCalled();
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

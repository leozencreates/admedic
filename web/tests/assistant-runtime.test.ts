import { describe, expect, it, vi } from "vitest";
import type { Role } from "@admedic/database";
import { ApiError } from "../app/_lib/client-api";
import { AssistantEventSchema, type AssistantEvent } from "../app/_lib/assistant/events";
import { createToolRuntime, TOOL_MESSAGES, TOOL_RATE_LIMIT } from "../app/_lib/assistant/runtime";
import {
  ElevenLabsAdapter,
  MockAdapter,
  matchMockCommand,
  toElevenLabsSessionOptions,
  type AdapterMessage,
  type AdapterStatus,
  type ElevenLabsControls,
} from "../app/_lib/assistant/adapter";
import { ASSISTANT_TOOLS } from "../app/_lib/assistant/registry";

const CAMPAIGNS = {
  campaigns: [
    { id: "cmp_fake_1", name: "Deneme kampanyası", status: "PAUSED", workflowStatus: "DRAFT", budgetCents: 1000, currency: "EUR" },
    { id: "cmp_fake_2", name: "İkinci deneme", status: "ACTIVE", workflowStatus: "ACTIVE", budgetCents: 2000, currency: "EUR" },
  ],
};

function setup(role: Role = "OWNER", responses: Record<string, unknown> = {}) {
  const events: AssistantEvent[] = [];
  const push = vi.fn();
  const api = vi.fn(async (url: string) => {
    const path = url.split("?")[0];
    const value = responses[path] ?? (path === "/api/campaigns" ? CAMPAIGNS : {});
    if (value instanceof Error) throw value;
    return value as never;
  });
  let clock = 0;
  const runtime = createToolRuntime({
    role,
    canApproveSpend: false,
    router: { push },
    api,
    reportEvent: (e) => {
      events.push(e);
    },
    getConversationId: () => "conv_fake_1",
    now: () => clock,
  });
  return { runtime, api, push, events, tick: (ms: number) => (clock += ms) };
}

const parse = (s: string) => JSON.parse(s) as Record<string, unknown>;

describe("araç dağıtıcısı: rol süzgeci", () => {
  it("rolün göremediği araç istemciye hiç bağlanmaz", () => {
    const viewer = setup("VIEWER").runtime;
    expect(viewer.clientTools.list_alerts).toBeUndefined();
    expect(viewer.clientTools.get_lead_stats).toBeUndefined();
    expect(viewer.clientTools.open_approvals).toBeUndefined();
    expect(viewer.clientTools.list_campaigns).toBeTypeOf("function");
    expect(viewer.tools.map((t) => t.name)).toEqual(Object.keys(viewer.clientTools));
  });
});

describe("araç dağıtıcısı: parametre doğrulama", () => {
  it("bilinmeyen alan (workspaceId) ve biçimsiz ref reddedilir, uç çağrılmaz", async () => {
    const { runtime, api, events } = setup();
    const r1 = parse(await runtime.clientTools.list_campaigns({ workspaceId: "ws_other" }));
    expect(r1).toMatchObject({ ok: false });
    expect(String(r1.error)).toContain(TOOL_MESSAGES.invalidParams);
    const r2 = parse(await runtime.clientTools.get_campaign({ ref: "cmp_fake_1" }));
    expect(r2.ok).toBe(false);
    const r3 = parse(await runtime.clientTools.navigate_to({ pageKey: "../api/x" }));
    expect(r3.ok).toBe(false);
    expect(api).not.toHaveBeenCalled();
    expect(events.map((e) => e.outcome)).toEqual(["error", "error", "error"]);
  });

  it("listede olmayan ref uydurulamaz", async () => {
    const { runtime, api } = setup();
    const result = parse(await runtime.clientTools.get_campaign({ ref: "c7" }));
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/bulunamadı/);
    expect(api).not.toHaveBeenCalled();
  });

  it("parametresiz araç `undefined` parametreyle de çalışır", async () => {
    const { runtime } = setup();
    expect(parse(await runtime.clientTools.get_today_summary(undefined)).ok).toBeUndefined();
  });
});

describe("araç dağıtıcısı: okuma ve gezinme", () => {
  it("liste ref verir; ref ile ayrıntı okunur ve kampanya sayfası açılır", async () => {
    const { runtime, api, push, events } = setup("OWNER", { "/api/campaigns/cmp_fake_1": { campaign: CAMPAIGNS.campaigns[0], metrics: {}, decisions: [], adSets: [] } });
    const list = parse(await runtime.clientTools.list_campaigns({}));
    expect(list.total).toBe(2);
    expect(JSON.stringify(list)).not.toContain("cmp_fake_1");
    const detail = parse(await runtime.clientTools.get_campaign({ ref: "c1" }));
    expect(detail.campaign).toMatchObject({ ref: "c1", name: "Deneme kampanyası" });
    expect(api).toHaveBeenLastCalledWith("/api/campaigns/cmp_fake_1");
    expect(await runtime.clientTools.open_campaign({ ref: "c2", tab: "performance" })).toBe("Kampanya sayfası açıldı.");
    expect(push).toHaveBeenLastCalledWith("/campaigns/cmp_fake_2?tab=performance");
    // Denetim kaydına gerçek kimlik gider (ajana değil), konuşma kimliğiyle.
    expect(events.at(-2)).toEqual({ type: "tool_call", tool: "get_campaign", risk: "R0", outcome: "ok", entityRef: "cmp_fake_1", conversationId: "conv_fake_1" });
    for (const e of events) expect(AssistantEventSchema.safeParse(e).success).toBe(true);
  });

  it("menüde olmayan sayfa açılmaz (reklam uzmanı → faturalar)", async () => {
    const { runtime, push, events } = setup("MEDIA_BUYER");
    const result = parse(await runtime.clientTools.navigate_to({ pageKey: "billing" }));
    expect(result).toMatchObject({ ok: false, error: "Bu sayfaya erişiminiz yok." });
    expect(push).not.toHaveBeenCalled();
    expect(events[0].outcome).toBe("denied");
    expect(await runtime.clientTools.navigate_to({ pageKey: "campaigns" })).toBe("Kampanyalar sayfası açıldı.");
    expect(push).toHaveBeenCalledWith("/campaigns");
  });

  it("uyarı listesi varsayılan olarak açık uyarıları ister", async () => {
    const { runtime, api } = setup();
    await runtime.clientTools.list_alerts({});
    expect(api).toHaveBeenCalledWith("/api/alerts?status=OPEN");
  });
});

describe("araç dağıtıcısı: hata eşleme", () => {
  it.each([
    [401, TOOL_MESSAGES.unauthorized, "denied"],
    [403, TOOL_MESSAGES.forbidden, "denied"],
    [404, TOOL_MESSAGES.notFound, "error"],
    [429, TOOL_MESSAGES.rateLimited, "error"],
    [500, TOOL_MESSAGES.failed, "error"],
  ] as const)("%i → kısa Türkçe ileti, ham sunucu iletisi gitmez", async (status, message, outcome) => {
    const { runtime, events } = setup("OWNER", { "/api/insights": new ApiError("ham sunucu iletisi cmp_secret", status) });
    const raw = await runtime.clientTools.get_insights({});
    expect(raw).not.toContain("ham sunucu");
    expect(parse(raw)).toMatchObject({ ok: false, error: message });
    expect(events[0]).toMatchObject({ tool: "get_insights", outcome });
  });

  it("beklenmeyen hata ve denetim bildirimi hatası aracı bozmaz", async () => {
    const api = vi.fn(async () => {
      throw new TypeError("x is undefined");
    });
    const runtime = createToolRuntime({
      role: "OWNER",
      canApproveSpend: false,
      router: { push: vi.fn() },
      api,
      reportEvent: () => {
        throw new Error("audit down");
      },
    });
    expect(parse(await runtime.clientTools.get_insights({}))).toMatchObject({ ok: false, error: TOOL_MESSAGES.failed });
    const rejecting = createToolRuntime({
      role: "OWNER",
      canApproveSpend: false,
      router: { push: vi.fn() },
      api: vi.fn(async () => ({}) as never),
      reportEvent: () => Promise.reject(new Error("audit down")),
    });
    await expect(rejecting.clientTools.get_insights({})).resolves.toBeTypeOf("string");
  });

  it("varsayılan bildirici olayı /api/assistant/events'e POST eder", async () => {
    const api = vi.fn(async () => ({}) as never);
    const runtime = createToolRuntime({ role: "OWNER", canApproveSpend: false, router: { push: vi.fn() }, api });
    await runtime.clientTools.pending_leads_count({});
    await Promise.resolve();
    expect(api).toHaveBeenCalledWith("/api/assistant/events", "POST", { type: "tool_call", tool: "pending_leads_count", risk: "R0", outcome: "ok" });
  });

  it(`oturum başına dakikada en çok ${TOOL_RATE_LIMIT.max} çağrı`, async () => {
    const { runtime, api, tick } = setup();
    for (let i = 0; i < TOOL_RATE_LIMIT.max; i++) await runtime.clientTools.pending_leads_count({});
    expect(parse(await runtime.clientTools.pending_leads_count({}))).toMatchObject({ ok: false, error: TOOL_MESSAGES.rateLimited });
    expect(api).toHaveBeenCalledTimes(TOOL_RATE_LIMIT.max);
    tick(TOOL_RATE_LIMIT.windowMs);
    expect(parse(await runtime.clientTools.pending_leads_count({})).ok).toBeUndefined();
  });
});

describe("senaryolu (mock) bağdaştırıcı", () => {
  const credentials = { connection: "webrtc" as const, conversationToken: "mock", conversationId: "conv_mock_1", serverLocation: "us", mock: true };

  async function started(role: Role) {
    const { runtime, api, push } = setup(role);
    const adapter = new MockAdapter({ delayMs: 0 });
    const messages: AdapterMessage[] = [];
    adapter.on("message", (m) => messages.push(m));
    await adapter.start({ credentials, clientTools: runtime.clientTools, assistantName: "Deneme Asistanı" });
    return { adapter, messages, api, push };
  }

  it("Türkçe kalıpları araçlara eşler", () => {
    expect(matchMockCommand("Kampanyaları göster")?.tool).toBe("list_campaigns");
    expect(matchMockCommand("onaylara git")).toEqual({ tool: "navigate_to", params: { pageKey: "approvals" } });
    expect(matchMockCommand("bugün ne var?")?.tool).toBe("get_today_summary");
    expect(matchMockCommand("ikinci kampanyayı aç")).toEqual({ tool: "open_campaign", params: { ref: "c2" } });
    expect(matchMockCommand("lead ara")?.tool).toBe("open_lead_search");
    expect(matchMockCommand("hava nasıl")).toBeNull();
  });

  it("selamlar, aracı gerçek dağıtıcıdan çalıştırır ve yanıt verir", async () => {
    const { adapter, messages, api, push } = await started("OWNER");
    expect(adapter.getStatus()).toBe("connected");
    expect(adapter.getConversationId()).toBe("conv_mock_1");
    expect(messages[0]).toEqual({ role: "agent", text: "Deneme Asistanı burada. Size nasıl yardımcı olabilirim?" });
    await adapter.sendUserMessage("kampanyaları göster");
    expect(api).toHaveBeenCalledWith("/api/campaigns");
    expect(messages.at(-1)).toEqual({ role: "agent", text: "2 kampanya var. İlk 2 tanesini listeledim." });
    await adapter.sendUserMessage("ilk kampanyayı aç");
    expect(push).toHaveBeenCalledWith("/campaigns/cmp_fake_1");
    await adapter.end();
    expect(adapter.getStatus()).toBe("disconnected");
  });

  it("yetkisiz rolde yetki yok der; desteklenmeyen komutta uyarır", async () => {
    const { adapter, messages, push } = await started("VIEWER");
    await adapter.sendUserMessage("onaylara git");
    expect(messages.at(-1)?.text).toBe("Bu sayfaya erişiminiz yok.");
    await adapter.sendUserMessage("uyarıları göster");
    expect(messages.at(-1)?.text).toBe(TOOL_MESSAGES.forbidden);
    await adapter.sendUserMessage("kampanyayı aktifleştir");
    expect(messages.at(-1)?.text).toBe("Bu komut henüz desteklenmiyor.");
    expect(push).not.toHaveBeenCalled();
  });
});

describe("ElevenLabs oturum seçenekleri", () => {
  it("WebRTC belirteci ve geçersiz kılmalar; istem ve ilk ileti gönderilmez", () => {
    const options = toElevenLabsSessionOptions({
      credentials: { connection: "webrtc", conversationToken: "tok", conversationId: "conv", serverLocation: "eu-residency", mock: false },
      clientTools: {},
      overrides: { language: "tr", voiceId: "voice_1" },
      textOnly: true,
    });
    expect(options).toMatchObject({
      connectionType: "webrtc",
      conversationToken: "tok",
      serverLocation: "eu-residency",
      textOnly: true,
      overrides: { agent: { language: "tr" }, tts: { voiceId: "voice_1" }, conversation: { textOnly: true } },
    });
    expect(JSON.stringify(options)).not.toMatch(/prompt|firstMessage/);
  });

  it("WebSocket imzalı URL; eksik kimlik bilgisi hata", () => {
    expect(
      toElevenLabsSessionOptions({ credentials: { connection: "websocket", signedUrl: "wss://x", serverLocation: "us", mock: false }, clientTools: {} }),
    ).toMatchObject({ connectionType: "websocket", signedUrl: "wss://x" });
    expect(() =>
      toElevenLabsSessionOptions({ credentials: { connection: "webrtc", serverLocation: "us", mock: false }, clientTools: {} }),
    ).toThrow();
  });
});

describe("araç dağıtıcısı: role bağlanmayan araçlar", () => {
  it("kayıttaki her araç ya bağlıdır ya da 'yetkiniz yok' saplamasıdır; saplama işleyici çalıştırmaz", async () => {
    const { runtime, api, events } = setup("VIEWER");
    const names = ASSISTANT_TOOLS.map((t) => t.name);
    expect(new Set([...Object.keys(runtime.clientTools), ...Object.keys(runtime.deniedTools)])).toEqual(new Set(names));
    for (const name of Object.keys(runtime.clientTools)) expect(runtime.deniedTools[name]).toBeUndefined();
    expect(runtime.deniedTools.list_alerts).toBeTypeOf("function");
    expect(parse(await runtime.deniedTools.list_alerts({}))).toMatchObject({ ok: false, error: TOOL_MESSAGES.forbidden });
    expect(api).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ type: "tool_call", tool: "list_alerts", outcome: "denied" });
  });
});

function fakeControls() {
  const calls = { start: 0, end: 0 };
  const controls: ElevenLabsControls = {
    startSession: () => void (calls.start += 1),
    endSession: () => void (calls.end += 1),
    sendUserMessage: () => undefined,
    sendContextualUpdate: () => undefined,
    getInputVolume: () => 0,
    getOutputVolume: () => 0,
  };
  return { controls, calls };
}

const WEBRTC = { connection: "webrtc" as const, conversationToken: "tok", conversationId: "conv", serverLocation: "us", mock: false };

describe("ElevenLabs bağdaştırıcısı", () => {
  it("bağlıyken gelen SDK hatası (ör. tanımsız araç) oturumu bitirmez; bağlanırken gelen hata ölümcüldür", async () => {
    const { controls } = fakeControls();
    const adapter = new ElevenLabsAdapter();
    adapter.bind(controls);
    const errors: string[] = [];
    adapter.on("error", (m) => errors.push(m));
    await adapter.start({ credentials: WEBRTC, clientTools: {} });
    adapter.handleStatus("connected");
    adapter.handleError("Client tool with name list_alerts is not defined on client");
    expect(errors).toEqual([]);
    expect(adapter.getStatus()).toBe("connected");

    const other = new ElevenLabsAdapter();
    other.bind(controls);
    other.on("error", (m) => errors.push(m));
    await other.start({ credentials: WEBRTC, clientTools: {} });
    other.handleError("Session failed to start");
    expect(errors).toEqual(["Session failed to start"]);
    expect(other.getStatus()).toBe("error");
  });

  it("önceki oturum kapanana kadar yeni oturum başlamaz ve eski olaylar yeni dinleyicilere gitmez", async () => {
    const { controls, calls } = fakeControls();
    const adapter = new ElevenLabsAdapter();
    adapter.bind(controls);
    await adapter.start({ credentials: WEBRTC, clientTools: {} });
    await adapter.end(); // Bağlantı kurulurken vazgeçildi.
    const seen: AdapterStatus[] = [];
    adapter.on("status", (s) => seen.push(s));
    const restart = adapter.start({ credentials: WEBRTC, clientTools: {} });
    await Promise.resolve();
    expect(calls.start).toBe(1);
    // Eski bekleyen bağlantı şimdi kuruldu ve kapandı: yeni dinleyici bunları görmez.
    adapter.handleStatus("connected");
    adapter.handleStatus("disconnecting");
    adapter.handleStatus("disconnected");
    await restart;
    expect(calls.start).toBe(2);
    expect(seen).toEqual(["connecting"]);
    adapter.handleStatus("connected");
    expect(seen).toEqual(["connecting", "connected"]);
  });

  it("önceki oturum süresinde kapanmazsa yeni başlatma görünür biçimde başarısız olur, sonraki deneme başlar", async () => {
    const { controls, calls } = fakeControls();
    const adapter = new ElevenLabsAdapter({ drainTimeoutMs: 5 });
    adapter.bind(controls);
    await adapter.start({ credentials: WEBRTC, clientTools: {} });
    await adapter.end();
    await expect(adapter.start({ credentials: WEBRTC, clientTools: {} })).rejects.toThrow();
    expect(calls.start).toBe(1);
    await adapter.start({ credentials: WEBRTC, clientTools: {} });
    expect(calls.start).toBe(2);
  });

  it("kapalı oturumda bitirmek beklemeye yol açmaz", async () => {
    const { controls, calls } = fakeControls();
    const adapter = new ElevenLabsAdapter({ drainTimeoutMs: 5 });
    adapter.bind(controls);
    await adapter.start({ credentials: WEBRTC, clientTools: {} });
    adapter.handleStatus("connected");
    adapter.handleStatus("disconnected"); // Ajan kapattı.
    await adapter.end();
    await adapter.start({ credentials: WEBRTC, clientTools: {} });
    expect(calls.start).toBe(2);
  });
});

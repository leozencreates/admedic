import { describe, expect, it, vi } from "vitest";

import {
  assistantLocationProblem,
  createAssistantSession,
  getConversationToken,
  getSignedUrl,
  missingAssistantConfig,
} from "./assistant-session";
import { VoiceApiError } from "./client";

const API_KEY = "xi_secret_key_test";

const env = {
  ELEVENLABS_API_KEY: API_KEY,
  ELEVENLABS_API_BASE: "https://api.elevenlabs.io",
  ELEVENLABS_ASSISTANT_AGENT_ID: "agent_assist_1",
  ELEVENLABS_ASSISTANT_CONNECTION: "webrtc" as const,
  ELEVENLABS_SERVER_LOCATION: "us" as const,
  META_MOCK_MODE: false,
};

describe("sesli asistan oturumu", () => {
  it("WebRTC: belgelenen uçtan belirteç alır, anahtarı yalnızca başlıkta gönderir", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ token: "tok_1", conversation_id: "conv_1" }));
    const session = await createAssistantSession({ env, fetchFn });
    expect(session).toEqual({
      connectionType: "webrtc",
      conversationToken: "tok_1",
      conversationId: "conv_1",
      serverLocation: "us",
      mock: false,
    });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=agent_assist_1");
    expect(init!.method).toBe("GET");
    expect((init!.headers as Record<string, string>)["xi-api-key"]).toBe(API_KEY);
    expect(init!.signal).toBeInstanceOf(AbortSignal);
    expect(String(url)).not.toContain(API_KEY);
    expect(JSON.stringify(session)).not.toContain(API_KEY);
  });

  it("WebSocket: imzalı URL alır; sondaki eğik çizgi ve ajan kimliği güvenle işlenir", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ signed_url: "wss://api.elevenlabs.io/v1/convai/conversation?agent_id=a&conversation_signature=s" }),
    );
    const session = await createAssistantSession({
      env: { ...env, ELEVENLABS_API_BASE: "https://api.elevenlabs.io/", ELEVENLABS_ASSISTANT_AGENT_ID: "agent a&b" },
      connection: "websocket",
      fetchFn,
    });
    expect(session.connectionType).toBe("websocket");
    expect(fetchFn.mock.calls[0]![0]).toBe(
      "https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=agent%20a%26b",
    );
    expect(JSON.stringify(session)).not.toContain(API_KEY);
  });

  it("ELEVENLABS_ASSISTANT_CONNECTION=websocket ise imzalı URL yolunu seçer", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ signed_url: "wss://x.elevenlabs.io/c" }));
    const session = await createAssistantSession({ env: { ...env, ELEVENLABS_ASSISTANT_CONNECTION: "websocket" }, fetchFn });
    expect(session).toMatchObject({ connectionType: "websocket", signedUrl: "wss://x.elevenlabs.io/c" });
    expect(String(fetchFn.mock.calls[0]![0])).toContain("/v1/convai/conversation/get-signed-url?");
  });

  it("yapılandırma eksikse istek atmaz ve eksik değişkenleri adlandırır", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    await expect(getConversationToken({ ...env, ELEVENLABS_ASSISTANT_AGENT_ID: undefined }, fetchFn)).rejects.toThrow(
      /ELEVENLABS_ASSISTANT_AGENT_ID/,
    );
    await expect(getSignedUrl({ ...env, ELEVENLABS_API_KEY: undefined }, fetchFn)).rejects.toThrow(/ELEVENLABS_API_KEY/);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(missingAssistantConfig({ ELEVENLABS_API_KEY: undefined, ELEVENLABS_ASSISTANT_AGENT_ID: undefined })).toEqual([
      "ELEVENLABS_API_KEY",
      "ELEVENLABS_ASSISTANT_AGENT_ID",
    ]);
  });

  it("bölge ile API kökü uyuşmazsa istek atmaz", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const eu = { ...env, ELEVENLABS_SERVER_LOCATION: "eu-residency" as const };
    await expect(getConversationToken(eu, fetchFn)).rejects.toThrow(/api\.eu\.residency\.elevenlabs\.io/);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(assistantLocationProblem({ ...eu, ELEVENLABS_API_BASE: "https://api.eu.residency.elevenlabs.io" })).toBeNull();
    expect(assistantLocationProblem({ ...env, ELEVENLABS_API_BASE: "https://api.in.residency.elevenlabs.io" })).not.toBeNull();
  });

  it("2xx dışı yanıtları Türkçe iletiye eşler; gövde, anahtar ve ajan kimliği sızmaz", async () => {
    const leaky = (status: number) =>
      vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ detail: `bad ${API_KEY} agent_assist_1` }), { status }));
    for (const [status, retryable, pattern] of [
      [401, false, /anahtarı reddetti/],
      [404, false, /ajanı bulunamadı/],
      [422, false, /isteği reddetti/],
      [429, true, /sınırına ulaşıldı/],
      [503, true, /hata verdi \(503\)/],
    ] as const) {
      const error = await getConversationToken(env, leaky(status)).catch((e) => e);
      expect(error).toBeInstanceOf(VoiceApiError);
      expect(error.providerStatus).toBe(status);
      expect(error.retryable).toBe(retryable);
      expect(error.message).toMatch(pattern);
      expect(error.message).not.toContain(API_KEY);
      expect(error.message).not.toContain("agent_assist_1");
    }

    const down = vi.fn<typeof fetch>().mockRejectedValue(new Error(`ECONNRESET ${API_KEY}`));
    const network = await getSignedUrl(env, down).catch((e) => e);
    expect(network).toBeInstanceOf(VoiceApiError);
    expect(network.retryable).toBe(true);
    expect(network.message).not.toContain(API_KEY);
  });

  it("eksik belirteç ya da wss olmayan URL reddedilir", async () => {
    const empty = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ conversation_id: "c" }));
    await expect(getConversationToken(env, empty)).rejects.toBeInstanceOf(VoiceApiError);
    const http = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ signed_url: "http://evil.example/x" }));
    await expect(getSignedUrl(env, http)).rejects.toThrow(/geçerli bir bağlantı adresi/);
  });

  it("deneme modunda dış istek yapılmaz ve yapılandırma gerekmez", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const bare = { ...env, ELEVENLABS_API_KEY: undefined, ELEVENLABS_ASSISTANT_AGENT_ID: undefined, META_MOCK_MODE: true };
    const webrtc = await createAssistantSession({ env: bare, fetchFn });
    expect(webrtc).toMatchObject({ connectionType: "webrtc", mock: true });
    const ws = await createAssistantSession({ env: { ...env, META_MOCK_MODE: false }, mock: true, connection: "websocket", fetchFn });
    expect(ws).toMatchObject({ connectionType: "websocket", mock: true });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(JSON.stringify([webrtc, ws])).not.toContain(API_KEY);
  });
});

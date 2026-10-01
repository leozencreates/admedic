import { loadEnv, type AppEnv } from "@admedic/config";
import { AdmedicError } from "@admedic/shared";

import { VoiceApiError } from "./client";

/**
 * Panel içi sesli komut asistanı için tarayıcı oturum kimliği (ADR-0028). YALNIZCA SUNUCUDA çalışır:
 * ElevenLabs API anahtarı tarayıcıya hiç gitmez; tarayıcı yalnızca kısa ömürlü belirteci ya da imzalı URL'yi alır.
 * Uç adları resmi API başvurusundan doğrulanmıştır (2026-10-01):
 *   - WebRTC:    GET /v1/convai/conversation/token?agent_id=…          → { token, conversation_id }
 *   - WebSocket: GET /v1/convai/conversation/get-signed-url?agent_id=… → { signed_url }
 * Deneme modunda (META_MOCK_MODE=true) hiçbir dış istek yapılmaz. VOICE_ASSISTANT_ENABLED bayrağı burada değil,
 * oturum ucunda denetlenir (kapalıysa 404).
 */

export type AssistantConnection = AppEnv["ELEVENLABS_ASSISTANT_CONNECTION"];
export type AssistantServerLocation = AppEnv["ELEVENLABS_SERVER_LOCATION"];

/** Tarayıcıya dönen değer; `startSession` seçenekleriyle birebir eşleşir. API anahtarı içermez. */
export type AssistantSessionCredential =
  | {
      connectionType: "webrtc";
      conversationToken: string;
      conversationId: string | null;
      serverLocation: AssistantServerLocation;
      mock: boolean;
    }
  | {
      connectionType: "websocket";
      signedUrl: string;
      serverLocation: AssistantServerLocation;
      mock: boolean;
    };

export type AssistantEnv = Pick<
  AppEnv,
  | "ELEVENLABS_API_KEY"
  | "ELEVENLABS_API_BASE"
  | "ELEVENLABS_ASSISTANT_AGENT_ID"
  | "ELEVENLABS_ASSISTANT_CONNECTION"
  | "ELEVENLABS_SERVER_LOCATION"
>;

const TOKEN_PATH = "/v1/convai/conversation/token";
const SIGNED_URL_PATH = "/v1/convai/conversation/get-signed-url";
const REQUEST_TIMEOUT_MS = 10_000;

/** Residency bölgeleri ayrı hesap ve ayrı API kökü kullanır (docs/elevenlabs-constraints.md "Veri konumu"). */
const RESIDENCY_HOST: Partial<Record<AssistantServerLocation, string>> = {
  "eu-residency": "api.eu.residency.elevenlabs.io",
  "in-residency": "api.in.residency.elevenlabs.io",
};

/** Asistan oturumu için eksik ortam değişkenleri; boş dizi yapılandırmanın tam olduğunu söyler. */
export function missingAssistantConfig(env: Pick<AppEnv, "ELEVENLABS_API_KEY" | "ELEVENLABS_ASSISTANT_AGENT_ID">): string[] {
  const missing: string[] = [];
  if (!env.ELEVENLABS_API_KEY) missing.push("ELEVENLABS_API_KEY");
  if (!env.ELEVENLABS_ASSISTANT_AGENT_ID) missing.push("ELEVENLABS_ASSISTANT_AGENT_ID");
  return missing;
}

/**
 * Sunucu tarafındaki API kökü ile tarayıcının bağlanacağı bölge aynı olmalı; aksi halde alınan belirteç tarayıcının
 * bağlandığı bölgede geçersizdir. Uyumsuzlukta Türkçe açıklama, uyumluysa null.
 */
export function assistantLocationProblem(env: Pick<AppEnv, "ELEVENLABS_API_BASE" | "ELEVENLABS_SERVER_LOCATION">): string | null {
  let host: string;
  try {
    host = new URL(env.ELEVENLABS_API_BASE).host.toLowerCase();
  } catch {
    return "ELEVENLABS_API_BASE geçerli bir adres değil.";
  }
  const expected = RESIDENCY_HOST[env.ELEVENLABS_SERVER_LOCATION];
  if (expected && host !== expected)
    return `ELEVENLABS_SERVER_LOCATION=${env.ELEVENLABS_SERVER_LOCATION} için ELEVENLABS_API_BASE https://${expected} olmalı.`;
  if (!expected && host.includes(".residency."))
    return "ELEVENLABS_API_BASE bir residency bölgesini gösteriyor; ELEVENLABS_SERVER_LOCATION aynı bölgeye ayarlanmalı.";
  return null;
}

function assertAssistantConfig(env: AssistantEnv) {
  const missing = missingAssistantConfig(env);
  if (missing.length > 0)
    throw new AdmedicError("CONFLICT", `Sesli asistan yapılandırılmamış: ${missing.join(", ")} sunucuda ayarlanmalı.`);
  const problem = assistantLocationProblem(env);
  if (problem) throw new AdmedicError("CONFLICT", `Sesli asistan yapılandırması tutarsız: ${problem}`);
}

/**
 * Hata iletileri yanıt gövdesini, ajan kimliğini ya da anahtarı içermez; yalnızca hangi ayarın denetleneceğini söyler.
 */
export function describeAssistantStatus(status: number): string {
  if (status === 401 || status === 403)
    return "Sesli asistan hizmeti anahtarı reddetti. ELEVENLABS_API_KEY ve ELEVENLABS_API_BASE (bölge) değerlerini denetleyin.";
  if (status === 404) return "Sesli asistan ajanı bulunamadı. ELEVENLABS_ASSISTANT_AGENT_ID değerini denetleyin.";
  if (status === 422 || status === 400)
    return "Sesli asistan hizmeti isteği reddetti. ELEVENLABS_ASSISTANT_AGENT_ID değerini ve ajanın kimlik doğrulama ayarını denetleyin.";
  if (status === 429) return "Sesli asistan sınırına ulaşıldı (hız ya da eşzamanlı oturum). Biraz sonra yeniden deneyin.";
  return `Sesli asistan hizmeti hata verdi (${status}). Biraz sonra yeniden deneyin.`;
}

async function getJson(env: AssistantEnv, path: string, fetchFn: typeof fetch): Promise<Record<string, unknown>> {
  assertAssistantConfig(env);
  const url = `${env.ELEVENLABS_API_BASE.replace(/\/$/, "")}${path}?agent_id=${encodeURIComponent(env.ELEVENLABS_ASSISTANT_AGENT_ID!)}`;
  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "GET",
      headers: { "xi-api-key": env.ELEVENLABS_API_KEY! },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new VoiceApiError("Sesli asistan hizmetine ulaşılamadı. Biraz sonra yeniden deneyin.", null, true);
  }
  if (!response.ok) {
    const retryable = response.status === 429 || response.status === 408 || response.status >= 500;
    throw new VoiceApiError(describeAssistantStatus(response.status), response.status, retryable);
  }
  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!data || typeof data !== "object")
    throw new VoiceApiError("Sesli asistan hizmeti beklenmeyen bir yanıt döndü.", response.status, false);
  return data;
}

const text = (value: unknown) => (typeof value === "string" && value ? value : null);

/** WebRTC için konuşma belirteci (`startSession({ conversationToken })`). */
export async function getConversationToken(
  env: AssistantEnv,
  fetchFn: typeof fetch = fetch,
): Promise<{ conversationToken: string; conversationId: string | null }> {
  const data = await getJson(env, TOKEN_PATH, fetchFn);
  const token = text(data.token);
  if (!token) throw new VoiceApiError("Sesli asistan hizmeti oturum belirteci döndürmedi.", 200, false);
  return { conversationToken: token, conversationId: text(data.conversation_id) };
}

/** WebSocket için imzalı URL (`startSession({ signedUrl })`). Yalnızca wss:// kabul edilir. */
export async function getSignedUrl(env: AssistantEnv, fetchFn: typeof fetch = fetch): Promise<{ signedUrl: string }> {
  const data = await getJson(env, SIGNED_URL_PATH, fetchFn);
  const signedUrl = text(data.signed_url);
  if (!signedUrl || !/^wss:\/\//i.test(signedUrl))
    throw new VoiceApiError("Sesli asistan hizmeti geçerli bir bağlantı adresi döndürmedi.", 200, false);
  return { signedUrl };
}

export interface AssistantSessionOptions {
  /** META_MOCK_MODE yerine geçer (test). */
  mock?: boolean;
  /** ELEVENLABS_ASSISTANT_CONNECTION yerine geçer (ör. mikrofon yokken yalnızca metin). */
  connection?: AssistantConnection;
  fetchFn?: typeof fetch;
  /** loadEnv() yerine geçer (test). */
  env?: AssistantEnv & Pick<AppEnv, "META_MOCK_MODE">;
}

/**
 * Yapılandırılmış bağlantı türüne göre belirteç ya da imzalı URL alır. Deneme modunda deterministik sahte değer döner,
 * dış istek ve yapılandırma denetimi yapılmaz.
 */
export async function createAssistantSession(options: AssistantSessionOptions = {}): Promise<AssistantSessionCredential> {
  const env = options.env ?? loadEnv();
  const connection = options.connection ?? env.ELEVENLABS_ASSISTANT_CONNECTION;
  const serverLocation = env.ELEVENLABS_SERVER_LOCATION;
  if (options.mock ?? env.META_MOCK_MODE) {
    return connection === "websocket"
      ? { connectionType: "websocket", signedUrl: "wss://mock.invalid/assistant", serverLocation, mock: true }
      : { connectionType: "webrtc", conversationToken: "mock_assistant_token", conversationId: "mock_assistant_conv", serverLocation, mock: true };
  }
  const fetchFn = options.fetchFn ?? fetch;
  if (connection === "websocket") {
    const { signedUrl } = await getSignedUrl(env, fetchFn);
    return { connectionType: "websocket", signedUrl, serverLocation, mock: false };
  }
  const { conversationToken, conversationId } = await getConversationToken(env, fetchFn);
  return { connectionType: "webrtc", conversationToken, conversationId, serverLocation, mock: false };
}

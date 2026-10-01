import { loadEnv, type AppEnv } from "@admedic/config";
import { AdmedicError } from "@admedic/shared";

/**
 * ElevenLabs Agents giden arama istemcisi (ADR-0026). Uç adları ve gövde alanları resmi dokümandan
 * doğrulanmıştır: docs/elevenlabs-constraints.md (2026-10-01).
 * Deneme modunda (META_MOCK_MODE=true) hiçbir dış istek yapılmaz.
 */

export interface PlaceCallInput {
  /** E.164 biçiminde aranacak numara. */
  toNumber: string;
  /** İki harfli dil kodu (`conversation_config_override.agent.language`). */
  language: string;
  /** Açılış cümlesi: yapay zekâ ve kayıt bildirimi (disclosure.ts). */
  firstMessage: string;
  /** Ajan isteminde `{{ad}}` olarak kullanılan değerler. Sağlık bilgisi GÖNDERİLMEZ. */
  dynamicVariables: Record<string, string | number | boolean>;
}

export interface PlacedCall {
  conversationId: string | null;
  /** Twilio `callSid` ya da SIP `sip_call_id`. */
  providerCallId: string | null;
}

export interface VoiceClient {
  /** true: gerçek arama yapılmaz (deneme modu). */
  readonly mock: boolean;
  /** Eksik ortam değişkenleri; boş değilse arama başlatılamaz. */
  readonly missingConfig: string[];
  placeCall(input: PlaceCallInput): Promise<PlacedCall>;
}

/** Sağlayıcı hatası; ileti telefon numarası ya da başka kişisel veri içermez. */
export class VoiceApiError extends AdmedicError {
  constructor(
    message: string,
    readonly providerStatus: number | null,
    /** Aynı istek biraz sonra yeniden denenebilir mi (hız sınırı, eşzamanlı arama sınırı, geçici hata)? */
    readonly retryable: boolean,
  ) {
    super(providerStatus === 429 ? "RATE_LIMIT" : "NETWORK_ERROR", message);
    this.name = "VoiceApiError";
  }
}

type VoiceEnv = Pick<
  AppEnv,
  | "ELEVENLABS_API_KEY"
  | "ELEVENLABS_AGENT_ID"
  | "ELEVENLABS_PHONE_NUMBER_ID"
  | "ELEVENLABS_TELEPHONY"
  | "ELEVENLABS_API_BASE"
>;

/** Arama başlatmak için eksik ortam değişkenleri; boş dizi yapılandırmanın tam olduğunu söyler. */
export function missingVoiceConfig(env: Pick<AppEnv, "ELEVENLABS_API_KEY" | "ELEVENLABS_AGENT_ID" | "ELEVENLABS_PHONE_NUMBER_ID">): string[] {
  const missing: string[] = [];
  if (!env.ELEVENLABS_API_KEY) missing.push("ELEVENLABS_API_KEY");
  if (!env.ELEVENLABS_AGENT_ID) missing.push("ELEVENLABS_AGENT_ID");
  if (!env.ELEVENLABS_PHONE_NUMBER_ID) missing.push("ELEVENLABS_PHONE_NUMBER_ID");
  return missing;
}

export function notConfigured(missing: string[]): AdmedicError {
  return new AdmedicError("CONFLICT", `Sesli arama yapılandırılmamış: ${missing.join(", ")} sunucuda ayarlanmalı.`);
}

const OUTBOUND_PATH = {
  twilio: "/v1/convai/twilio/outbound-call",
  sip_trunk: "/v1/convai/sip-trunk/outbound-call",
} as const;

export class ElevenLabsVoiceClient implements VoiceClient {
  readonly mock = false;

  constructor(
    private readonly env: VoiceEnv,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  get missingConfig(): string[] {
    return missingVoiceConfig(this.env);
  }

  async placeCall(input: PlaceCallInput): Promise<PlacedCall> {
    if (this.missingConfig.length > 0) throw notConfigured(this.missingConfig);
    const url = `${this.env.ELEVENLABS_API_BASE.replace(/\/$/, "")}${OUTBOUND_PATH[this.env.ELEVENLABS_TELEPHONY]}`;
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: "POST",
        headers: { "xi-api-key": this.env.ELEVENLABS_API_KEY!, "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: this.env.ELEVENLABS_AGENT_ID,
          agent_phone_number_id: this.env.ELEVENLABS_PHONE_NUMBER_ID,
          to_number: input.toNumber,
          conversation_initiation_client_data: {
            dynamic_variables: input.dynamicVariables,
            // Geçersiz kılmalar ajanın Security sekmesinde açık olmalıdır; kapalıysa ElevenLabs aramayı
            // reddeder. Böylece bildirim cümlesi söylenmeden arama yapılamaz.
            conversation_config_override: {
              agent: { first_message: input.firstMessage, language: input.language },
            },
          },
        }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new VoiceApiError("Sesli arama hizmetine ulaşılamadı. Biraz sonra yeniden deneyin.", null, true);
    }
    if (!response.ok) {
      const retryable = response.status === 429 || response.status === 408 || response.status >= 500;
      throw new VoiceApiError(describeStatus(response.status), response.status, retryable);
    }
    const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!data || data.success === false)
      throw new VoiceApiError("Sesli arama hizmeti aramayı başlatamadı. Ajan ve numara ayarlarını denetleyin.", response.status, false);
    const text = (value: unknown) => (typeof value === "string" && value ? value : null);
    return {
      conversationId: text(data.conversation_id),
      providerCallId: text(data.callSid) ?? text(data.sip_call_id),
    };
  }
}

function describeStatus(status: number): string {
  if (status === 401 || status === 403) return "Sesli arama hizmeti anahtarı reddetti. ELEVENLABS_API_KEY değerini denetleyin.";
  if (status === 404) return "Sesli ajan ya da telefon numarası bulunamadı. ELEVENLABS_AGENT_ID ve ELEVENLABS_PHONE_NUMBER_ID değerlerini denetleyin.";
  if (status === 422 || status === 400)
    return "Sesli arama hizmeti isteği reddetti. Ajanın Security sekmesinde açılış cümlesi ve dil geçersiz kılmalarının açık olduğunu denetleyin.";
  if (status === 429) return "Sesli arama sınırına ulaşıldı (hız ya da eşzamanlı arama). Biraz sonra yeniden deneyin.";
  return `Sesli arama hizmeti hata verdi (${status}). Biraz sonra yeniden deneyin.`;
}

/** Deneme modu: deterministik sahte sonuç, dış istek yok. */
export class MockVoiceClient implements VoiceClient {
  readonly mock = true;
  readonly missingConfig: string[] = [];
  readonly calls: PlaceCallInput[] = [];

  async placeCall(input: PlaceCallInput): Promise<PlacedCall> {
    this.calls.push(input);
    const ref = String(input.dynamicVariables.call_ref ?? this.calls.length);
    return { conversationId: `mock_conv_${ref}`, providerCallId: `mock_call_${ref}` };
  }
}

export interface VoiceClientOptions {
  /** META_MOCK_MODE yerine geçer (test). */
  mock?: boolean;
  fetchFn?: typeof fetch;
}

export function createVoiceClient(options: VoiceClientOptions = {}): VoiceClient {
  const env = loadEnv();
  if (options.mock ?? env.META_MOCK_MODE) return new MockVoiceClient();
  return new ElevenLabsVoiceClient(env, options.fetchFn);
}

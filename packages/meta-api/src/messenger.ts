import { loadEnv } from "@admedic/config";
import { getGraphVersion } from "./http";

/**
 * Messenger / Instagram DM giden metin mesajı (Meta Send API) — worker gibi Prisma'sız
 * ortamlar için saf taşıyıcı: sayfa token'ı ve hedef kimliği çağıran çözer.
 * `POST https://graph.facebook.com/{version}/{targetId}/messages`
 * `META_MOCK_MODE=true` iken hiçbir dış istek yapılmaz.
 */

/** Send API metin mesajı üst sınırı (Meta: 2000 karakter). */
export const MESSENGER_TEXT_LIMIT = 2000;

export interface MessengerTextInput {
  /** Çözülmüş sayfa erişim token'ı (yalnızca Authorization başlığında taşınır). */
  token: string | null;
  /** Sayfa kimliği (Messenger) ya da Instagram profesyonel hesap kimliği; yoksa "me". */
  targetId?: string | null;
  /** Alıcının sayfa kapsamlı kimliği. */
  psid: string | null;
  text: string;
  /** 24 saat penceresi dışında `MESSAGE_TAG` + `HUMAN_AGENT`. */
  humanAgent?: boolean;
  fetchFn?: typeof fetch;
}

export interface MessengerTextResult {
  id?: string | null;
  error?: string | null;
  humanAgentTag?: boolean;
}

interface GraphErrorShape {
  error?: { message?: string; code?: number; error_subcode?: number; type?: string };
}

/** Meta hata kodlarını kullanıcıya anlamlı Türkçe mesaja çevirir (token/PII içermez). */
export function describeMessengerSendError(status: number, data: GraphErrorShape | null): string {
  const code = data?.error?.code;
  const subcode = data?.error?.error_subcode;
  const message = data?.error?.message ?? "";
  if (code === 10 && (subcode === 2018278 || /24 hour|outside of allowed window/i.test(message)))
    return "24 saatlik Messenger penceresi dışında; gönderim için uygulamanın Human Agent (HUMAN_AGENT) izni gerekir.";
  if (code === 10 || (code === 200 && /permission/i.test(message)))
    return "Meta bu gönderime izin vermedi: sayfa mesajlaşma izni (pages_messaging) veya Human Agent izni eksik olabilir.";
  if (code === 190) return "Sayfa erişim token'ı geçersiz veya süresi dolmuş; Meta bağlantısını yenileyin.";
  if (code === 551) return "Alıcı şu anda mesaj alamıyor (Meta: kullanıcı erişilemez).";
  if (code === 100 && /recipient/i.test(message)) return "Alıcı kimliği (PSID) bu sayfa için geçersiz.";
  if (message) return `Meta Messenger API hatası (${code ?? status}): ${message.slice(0, 200)}`;
  return `Meta Messenger API hatası: ${status}`;
}

export async function sendMessengerText(input: MessengerTextInput): Promise<MessengerTextResult> {
  const env = loadEnv();
  const humanAgentTag = Boolean(input.humanAgent);
  if (!input.text.trim()) return { error: "Mesaj içeriği boş olamaz." };
  if (input.text.length > MESSENGER_TEXT_LIMIT)
    return { error: `Messenger/Instagram mesajı en fazla ${MESSENGER_TEXT_LIMIT} karakter olabilir.` };
  // Mock modda hiçbir koşulda dış istek yapılmaz.
  if (env.META_MOCK_MODE) return { id: "mock_" + Date.now(), error: null, humanAgentTag };
  if (!input.psid) return { error: "Lead için Messenger/Instagram alıcı kimliği (psid) yok." };
  if (!input.token) return { error: "Sayfa erişim token'ı yok; Meta bağlantısını yenileyin." };
  let version: string;
  try {
    version = getGraphVersion();
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Graph API sürümü ayarlanmadı." };
  }
  const payload = {
    recipient: { id: input.psid },
    ...(humanAgentTag
      ? { messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT" }
      : { messaging_type: "RESPONSE" }),
    message: { text: input.text },
  };
  const fetchFn = input.fetchFn ?? fetch;
  try {
    const response = await fetchFn(
      `https://graph.facebook.com/${version}/${encodeURIComponent(input.targetId ?? "me")}/messages`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${input.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      },
    );
    type SendApiResponse = GraphErrorShape & { message_id?: string; recipient_id?: string };
    let data: SendApiResponse | null = null;
    try {
      data = (await response.json()) as SendApiResponse;
    } catch {
      data = null;
    }
    if (!response.ok || data?.error)
      return { error: describeMessengerSendError(response.status, data), humanAgentTag };
    return { id: data?.message_id ?? null, error: null, humanAgentTag };
  } catch {
    return { error: "Messenger mesajı gönderilemedi (ağ hatası veya zaman aşımı).", humanAgentTag };
  }
}

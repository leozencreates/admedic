import { loadEnv } from "@admedic/config";

/** WhatsApp Cloud API taşıyıcısı — worker ve diğer paketler için `web/app/_lib/whatsapp.ts` kopyası. */

/** Meta şablon adları küçük harf, rakam ve alt çizgiden oluşur (en fazla 512 karakter). */
export const TEMPLATE_PATTERN = /^[a-z0-9_]{1,512}$/;
export const WINDOW_MS = 24 * 3600 * 1000;

export interface WhatsAppResponse {
  id?: string | null;
  error?: string | null;
}

/**
 * Şablon adını Meta'nın beklediği biçime getirir: büyük harf gelirse küçültülür,
 * yine de kalıba uymuyorsa null döner.
 */
export function normalizeTemplateName(name: string | null | undefined): string | null {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return null;
  const lowered = trimmed.toLowerCase();
  return TEMPLATE_PATTERN.test(lowered) ? lowered : null;
}

/**
 * Şablon dili: lead dili 2 harfli kod ise (tr, ar, de…) küçük harfle kullanılır;
 * "en-US"/"en_US" gibi bölgeli kodlar "en_US" biçimine çevrilir; tanınmayan
 * değerlerde ürün varsayılanı "tr" kullanılır.
 */
export function templateLanguageCode(language: string | null | undefined): string {
  const raw = (language ?? "").trim();
  if (/^[a-z]{2}$/i.test(raw)) return raw.toLowerCase();
  const regional = raw.match(/^([a-z]{2})[-_]([a-z]{2})$/i);
  // web/app/_lib/whatsapp.ts'in birebir kopyası; tek fark noUncheckedIndexedAccess için `!`.
  if (regional) return `${regional[1]!.toLowerCase()}_${regional[2]!.toUpperCase()}`;
  return "tr";
}

/** Tenant'a özel WhatsApp Cloud API hedefi (MetaConnection.whatsappPhoneNumberId + şifreli token). */
export interface WhatsAppTransport {
  apiUrl: string;
  token: string;
  /**
   * Token bu uygulamanın OAuth bağlantısından geldiğinde `appsecret_proof` ("Require App Secret").
   * Ortam düzeyi WHATSAPP_TOKEN'a kanıt eklenmez: başka bir uygulamada üretilmiş olabilir ve yanlış kanıt
   * çağrıyı reddettirir.
   */
  appsecretProof?: string | null;
}

export async function sendWhatsAppMessage(
  lead: { phone: string | null; language: string; transport?: WhatsAppTransport | null },
  content: string,
  templateName: string | null = null,
  templateParams: Record<string, string> = {},
): Promise<WhatsAppResponse> {
  const phone = lead.phone;
  const env = loadEnv();
  if (!phone) return { error: "Lead telefon numarası yok." };
  // Mock modda hiçbir koşulda dış istek yapılmaz (safety.test bunu doğrular).
  if (env.META_MOCK_MODE) return { id: "mock_" + Date.now(), error: null };
  // Çok kiracılı kurulumda tenant'ın kendi numarası/token'ı kullanılır; yoksa ortam düzeyi tek numara.
  const token = lead.transport?.token ?? env.WHATSAPP_TOKEN;
  const url = lead.transport?.apiUrl ?? env.WHATSAPP_API_URL;
  if (!token || !url) {
    return { error: "WhatsApp API yapılandırılmamış (bağlantıda WhatsApp numarası ya da WHATSAPP_API_URL/WHATSAPP_TOKEN)." };
  }
  const normalizedTemplate = templateName ? normalizeTemplateName(templateName) : null;
  if (templateName && !normalizedTemplate)
    return { error: "Geçersiz WhatsApp şablonu adı." };

  const payload = normalizedTemplate
    ? {
        messaging_product: "whatsapp",
        to: phone,
        type: "template",
        template: {
          name: normalizedTemplate,
          language: { code: templateLanguageCode(lead.language) },
          components: [
            {
              type: "body",
              parameters: Object.values(templateParams).map((v) => ({ text: v })),
            },
          ],
        },
      }
    : {
        messaging_product: "whatsapp",
        to: phone,
        type: "text",
        text: { body: content },
      };
  try {
    const proof = lead.transport?.appsecretProof;
    const response = await fetch(`${url}/messages${proof ? `?appsecret_proof=${encodeURIComponent(proof)}` : ""}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok)
      return { error: `WhatsApp API hatası: ${response.status}` };
    const data = await response.json();
    return { id: data.messages?.[0]?.id ?? null };
  } catch {
    return { error: "WhatsApp gönderilemedi." };
  }
}

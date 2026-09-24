import { loadEnv } from "@admedic/config";

export const TEMPLATE_PATTERN = /^[A-Z0-9_]{1,32}$/;
export const WINDOW_MS = 24 * 3600 * 1000;

export interface WhatsAppResponse {
  id?: string | null;
  error?: string | null;
}

export async function sendWhatsAppMessage(
  lead: { phone: string | null; language: string },
  content: string,
  templateName: string | null = null,
  templateParams: Record<string, string> = {},
): Promise<WhatsAppResponse> {
  const phone = lead.phone;
  const token = process.env.WHATSAPP_TOKEN;
  const url = process.env.WHATSAPP_API_URL;
  if (!phone) return { error: "Lead telefon numarası yok." };
  const mockMode = loadEnv().META_MOCK_MODE;
  if (!token || !url) {
    if (mockMode) return { id: "mock_" + Date.now(), error: null };
    return { error: "WhatsApp API yapılandırılmamış (WHATSAPP_API_URL/WHATSAPP_TOKEN)." };
  }
  if (templateName && !TEMPLATE_PATTERN.test(templateName))
    return { error: "Geçersiz WhatsApp şablonu adı." };

  const payload = templateName
    ? {
        messaging_product: "whatsapp",
        to: phone,
        type: "template",
        template: {
          name: templateName,
          language: { code: lead.language.toLowerCase() },
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
    const response = await fetch(`${url}/messages`, {
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
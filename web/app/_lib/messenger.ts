import { prisma } from "@admedic/database";
import { loadEnv } from "@admedic/config";
import { getGraphVersion } from "@admedic/meta-api";
import { tryDecryptField } from "./encrypt";

/**
 * Messenger / Instagram DM giden mesaj (Meta Send API).
 * - Messenger: `POST https://graph.facebook.com/{version}/{pageId}/messages`
 * - Instagram: `POST https://graph.facebook.com/{version}/{igId}/messages`
 * Sayfa token'ı `MetaConnection` (orgId + pageId/instaId, CONNECTED, tokenCiphertext)
 * kaydından çözülür ve yalnızca Authorization başlığında taşınır (sorgu dizesine konmaz).
 * `META_MOCK_MODE=true` iken hiçbir dış istek yapılmaz.
 */

export type MessengerChannel = "MESSENGER" | "INSTAGRAM";

export interface MessengerSendInput {
  orgId: string;
  channel: MessengerChannel;
  /** Alıcının sayfa kapsamlı kimliği (lead.metadata.psid). */
  psid: string | null;
  /** Lead'in geldiği sayfa/Instagram hesabı kimliği (lead.metadata.page_id); yoksa org'un bağlı sayfası kullanılır. */
  pageId?: string | null;
  text: string;
  /**
   * Son gelen mesajdan 24 saat geçtiyse Messenger standart yanıt penceresi kapanır;
   * gönderim `messaging_type: "MESSAGE_TAG"` + `tag: "HUMAN_AGENT"` ile yapılır
   * (uygulamada Human Agent izni yoksa Meta hata döner).
   */
  humanAgent?: boolean;
}

export interface MessengerResponse {
  id?: string | null;
  error?: string | null;
  /** İstekte HUMAN_AGENT etiketi kullanıldı mı. */
  humanAgentTag?: boolean;
}

interface GraphErrorShape {
  error?: { message?: string; code?: number; error_subcode?: number; type?: string };
}

/** Meta hata kodlarını kullanıcıya anlamlı Türkçe mesaja çevirir (token/PII içermez). */
export function describeMessengerError(status: number, data: GraphErrorShape | null): string {
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

/** Send API metin mesajı üst sınırı (Meta: 2000 karakter). */
export const MESSENGER_TEXT_LIMIT = 2000;

export async function sendMessengerMessage(input: MessengerSendInput): Promise<MessengerResponse> {
  const env = loadEnv();
  const humanAgentTag = Boolean(input.humanAgent);
  if (!input.text.trim()) return { error: "Mesaj içeriği boş olamaz." };
  if (input.text.length > MESSENGER_TEXT_LIMIT)
    return { error: `Messenger/Instagram mesajı en fazla ${MESSENGER_TEXT_LIMIT} karakter olabilir.` };
  // Mock modda hiçbir koşulda dış istek yapılmaz.
  if (env.META_MOCK_MODE) return { id: "mock_" + Date.now(), error: null, humanAgentTag };
  if (!input.psid) return { error: "Lead için Messenger/Instagram alıcı kimliği (psid) yok." };

  const pageMatch = input.pageId
    ? input.channel === "INSTAGRAM"
      ? { OR: [{ instaId: input.pageId }, { pageId: input.pageId }] }
      : { pageId: input.pageId }
    : input.channel === "INSTAGRAM"
      ? { instaId: { not: null } }
      : { pageId: { not: null } };
  const connection = await prisma.metaConnection.findFirst({
    where: {
      orgId: input.orgId,
      status: "CONNECTED",
      tokenCiphertext: { not: null },
      ...pageMatch,
    },
    orderBy: { updatedAt: "desc" },
    select: { pageId: true, instaId: true, tokenCiphertext: true },
  });
  if (!connection)
    return { error: "Bu sayfa için bağlı ve aktif bir Meta sayfa bağlantısı (token) bulunamadı." };
  const token = tryDecryptField(connection.tokenCiphertext);
  if (!token) return { error: "Sayfa erişim token'ı çözülemedi; Meta bağlantısını yenileyin." };

  const targetId =
    input.channel === "INSTAGRAM"
      ? connection.instaId ?? "me"
      : connection.pageId ?? "me";
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
  try {
    const response = await fetch(
      `https://graph.facebook.com/${version}/${encodeURIComponent(targetId)}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
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
      return { error: describeMessengerError(response.status, data), humanAgentTag };
    return { id: data?.message_id ?? null, error: null, humanAgentTag };
  } catch {
    return { error: "Messenger mesajı gönderilemedi (ağ hatası veya zaman aşımı).", humanAgentTag };
  }
}

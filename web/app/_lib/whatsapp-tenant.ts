import { prisma } from "@admedic/database";
import { loadEnv } from "@admedic/config";
import { appSecretProof, getGraphVersion } from "@admedic/meta-api";
import { tryDecryptField } from "./encrypt";
import type { WhatsAppTransport } from "./whatsapp";

/**
 * Tenant'ın WhatsApp Cloud API hedefini çözer: `MetaConnection.whatsappPhoneNumberId` ve şifreli
 * token'ı olan aktif bağlantı → `https://graph.facebook.com/{version}/{phone_number_id}`.
 * Eşleme yoksa null döner; gönderici ortam düzeyi WHATSAPP_API_URL/WHATSAPP_TOKEN'a düşer
 * (tek kiracılı kurulum). Çok kiracılı kurulumda her tenant'ın eşlemesi olmalıdır.
 * `META_APP_SECRET` varsa `appsecret_proof` hesaplanır (yalnızca bağlantı token'ı için).
 */
export async function resolveWhatsAppTransport(orgId: string): Promise<WhatsAppTransport | null> {
  const connection = await prisma.metaConnection.findFirst({
    where: {
      orgId,
      status: { in: ["CONNECTED", "DEGRADED"] },
      whatsappPhoneNumberId: { not: null },
      tokenCiphertext: { not: null },
    },
    orderBy: [{ type: "asc" }, { updatedAt: "desc" }],
    select: { whatsappPhoneNumberId: true, tokenCiphertext: true },
  });
  if (!connection?.whatsappPhoneNumberId) return null;
  const token = tryDecryptField(connection.tokenCiphertext);
  if (!token) return null;
  let version: string;
  try {
    version = getGraphVersion();
  } catch {
    return null;
  }
  return {
    apiUrl: `https://graph.facebook.com/${version}/${connection.whatsappPhoneNumberId}`,
    token,
    // Bağlantı token'ı bu uygulamanın OAuth akışından gelir → kanıt geçerlidir.
    appsecretProof: appSecretProof(token, loadEnv().META_APP_SECRET) ?? null,
  };
}

import { createHmac } from "node:crypto";
import { loadEnv } from "@admedic/config";

/**
 * `appsecret_proof` = HMAC-SHA256(access_token, app_secret) (hex). Uygulama ayarında "Require App Secret"
 * açıkken sunucu tarafı Graph çağrılarında zorunludur; kapalıyken doğru kanıt yine kabul edilir.
 * Yalnızca bu uygulamanın ürettiği token'larla (OAuth kullanıcı token'ı ve ondan türeyen sayfa token'ları)
 * kullanılmalıdır: başka bir uygulamanın token'ına eklenen kanıt geçersiz sayılır ve çağrı reddedilir.
 * `appSecret` verilmezse `META_APP_SECRET` okunur; secret yoksa `undefined` döner (parametre gönderilmez).
 * Kaynak: developers.facebook.com/docs/graph-api/guides/secure-requests (bkz. docs/meta-constraints.md).
 */
export function appSecretProof(accessToken: string, appSecret?: string): string | undefined {
  const secret = appSecret ?? loadEnv().META_APP_SECRET;
  if (!secret || !accessToken) return undefined;
  return createHmac("sha256", secret).update(accessToken).digest("hex");
}

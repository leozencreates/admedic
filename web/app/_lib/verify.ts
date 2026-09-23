import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Meta webhook imza doğrulaması (X-Hub-Signature-256).
 * Secret boşsa veya imza başlığı yoksa/gardawıssa başarısız sayılır (fail-closed).
 * Karşılaştırma sabit zamanlı yapılır.
 */
export function verifyWebhookSignature(
  payload: string,
  signature: string | null,
  secret: string | null | undefined,
): boolean {
  if (!secret || secret.length === 0) return false;
  if (!signature) return false;
  const prefix = "sha256=";
  if (!signature.startsWith(prefix)) return false;
  const provided = Buffer.from(signature.slice(prefix.length), "hex");
  const expected = createHmac("sha256", secret).update(payload).digest();
  return (
    provided.length === expected.length && timingSafeEqual(provided, expected)
  );
}
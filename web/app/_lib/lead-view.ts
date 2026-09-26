import type { Role } from "@admedic/database";
import { CARE_ROLES } from "./auth";
import { decrypt, maskEmail, maskPhone } from "./encrypt";

/** Yanıtta hiç gösterilmeyen, kişisel veri taşıyabilen metadata anahtarları (her derinlikte). */
export const PII_METADATA_KEYS = new Set([
  "email",
  "phone",
  "phone_number",
  "full_name",
  "first_name",
  "last_name",
]);

/** Kişisel veriyi (telefon/e-posta) açık görebilen roller; VIEWER/ANALYST maskeli görür. */
export function canViewPii(role: Role): boolean {
  return CARE_ROLES.includes(role);
}

export function safeDecrypt(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return decrypt(value);
  } catch {
    return "[şifre çözülemedi]";
  }
}

/** Role göre açık ya da maskelenmiş iletişim bilgisi. */
export function presentContact(
  role: Role,
  encrypted: { email: string | null; phone: string | null },
): { email: string | null; phone: string | null } {
  const email = safeDecrypt(encrypted.email);
  const phone = safeDecrypt(encrypted.phone);
  if (canViewPii(role)) return { email, phone };
  return { email: maskEmail(email), phone: maskPhone(phone) };
}

/** Webhook idempotency/kaynak anahtarları: PATCH ile asla ezilmez ya da silinmez. */
export const PROTECTED_METADATA_KEYS = new Set(["leadgen_id", "mid", "psid", "source", "page_id"]);

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** İzinli anahtarları mevcut metadata üzerine bindirir; `null` değer anahtarı siler, korumalı anahtarlar atlanır. */
export function mergeLeadMetadata(
  existing: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(patch)) {
    if (PROTECTED_METADATA_KEYS.has(key)) continue;
    if (value === null) delete out[key];
    else out[key] = value;
  }
  return out;
}

/** metadata içindeki PII benzeri anahtarları (iç içe nesneler dahil) yanıttan çıkarır. */
export function sanitizeMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeMetadata);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (PII_METADATA_KEYS.has(key.toLowerCase())) continue;
      out[key] = sanitizeMetadata(inner);
    }
    return out;
  }
  return value;
}

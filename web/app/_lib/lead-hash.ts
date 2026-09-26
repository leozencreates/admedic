import { createHash } from "node:crypto";

/**
 * Telefonu karşılaştırılabilir hale getirir: rakam dışı karakterler atılır,
 * uluslararası "00" öneki kaldırılır, "0" ile başlayan 10-11 haneli yerel
 * Türkiye numaraları "90…" biçimine çevrilir ("0532 111 22 33" ve
 * "+90 532 111 22 33" aynı sonucu verir).
 */
export function normalizePhone(value: string | null | undefined): string {
  let digits = (value ?? "").replace(/[^0-9]/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (/^0\d{9,10}$/.test(digits)) digits = `90${digits.slice(1)}`;
  return digits;
}

/** E-postayı karşılaştırılabilir hale getirir (kırp + küçük harf). */
export function normalizeEmail(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

/**
 * Lead tekrar tespiti için kararlı (tenant kapsamlı) tek yönlü hash.
 * Öncelik: Instagram kimliği > Messenger PSID > telefon > e-posta. Telefon
 * varsa yalnızca telefon anahtarı kullanılır; böylece aynı numara farklı bir
 * e-postayla gelse de aynı kişi olarak eşleşir. Telefon yoksa e-posta esas alınır.
 */
export function leadLookupHash(input: {
  orgId: string;
  phone?: string | null;
  email?: string | null;
  psid?: string | null;
  igId?: string | null;
}): string | null {
  let key: string | null = null;
  if (input.igId) {
    key = `ig:${input.igId}`;
  } else if (input.psid) {
    key = `psid:${input.psid}`;
  } else {
    const phone = normalizePhone(input.phone);
    const email = normalizeEmail(input.email);
    key = phone ? `phone:${phone}` : email ? `email:${email}` : null;
  }
  if (!key) return null;
  return createHash("sha256")
    .update(`${input.orgId}:${key}`)
    .digest("hex");
}

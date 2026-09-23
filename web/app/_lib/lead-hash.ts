import { createHash } from "node:crypto";

/**
 * Lead tekrar tespiti için kararlı (tenant kapsamlı) tek yönlü hash.
 * Telefon/e-posta normalize edilerek üretilir; Messenger PSID yalnızca
 * telefondan ayrıştırıldığı kanallarda kullanılır.
 */
export function leadLookupHash(input: {
  orgId: string;
  phone?: string | null;
  email?: string | null;
  psid?: string | null;
}): string | null {
  let parts: string[];
  if (input.psid) {
    parts = [`psid:${input.psid}`];
  } else {
    parts = [input.phone ?? "", input.email ?? ""].filter(Boolean);
  }
  if (parts.length === 0) return null;
  return createHash("sha256")
    .update(`${input.orgId}:${parts.join("|")}`)
    .digest("hex");
}
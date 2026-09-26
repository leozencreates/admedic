/**
 * Alan seviyesinde şifreleme — tek kaynak `@admedic/config` (web + worker aynı anahtar türetimi).
 * Bu modül geriye dönük import uyumluluğu için ince bir sarmalayıcıdır.
 */
import { decryptField, encryptField, maskEmail, maskPhone, tryDecryptField } from "@admedic/config";

export function encrypt(plaintext: string | null): string | null {
  return encryptField(plaintext);
}
export function decrypt(ciphertext: string): string {
  return decryptField(ciphertext);
}
export { maskEmail, maskPhone, tryDecryptField };

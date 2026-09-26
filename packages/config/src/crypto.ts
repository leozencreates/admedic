import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { loadEnv } from "./env";

/**
 * Alan seviyesinde şifreleme (spec 3.11): AES-256-GCM.
 * Web (lead telefon/e-posta) ve worker (Meta token) AYNI anahtar türetimini kullanır;
 * tek kaynak burasıdır. Format: base64( iv(16) | authTag(16) | ciphertext ).
 */
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const SALT = "admedic-salt";

let cachedKey: { source: string; key: Buffer } | undefined;

/** scrypt pahalıdır (~30 ms); anahtar süreç ömrü boyunca bir kez türetilir. */
export function getFieldEncryptionKey(): Buffer {
  const source = (process.env.ENCRYPTION_KEY ?? loadEnv().ENCRYPTION_KEY ?? "").trim();
  if (!source) throw new Error("ENCRYPTION_KEY ayarlanmamış (64 hex karakter).");
  if (cachedKey?.source === source) return cachedKey.key;
  const key = scryptSync(source, SALT, KEY_LENGTH);
  cachedKey = { source, key };
  return key;
}

export function encryptField(plaintext: string | null | undefined): string | null {
  if (!plaintext) return null;
  const key = getFieldEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}

export function decryptField(ciphertext: string): string {
  const key = getFieldEncryptionKey();
  const buffer = Buffer.from(ciphertext, "base64");
  if (buffer.length < IV_LENGTH + TAG_LENGTH) throw new Error("Geçersiz şifreli veri.");
  const iv = buffer.subarray(0, IV_LENGTH);
  const authTag = buffer.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const encrypted = buffer.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

/** Çözülemeyen değer için güvenli okuma: hata fırlatmaz. */
export function tryDecryptField(ciphertext: string | null | undefined): string | null {
  if (!ciphertext) return null;
  try {
    return decryptField(ciphertext);
  } catch {
    return null;
  }
}

export function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const [local, domain] = email.split("@");
  if (!domain || !local) return email;
  return `${local[0]}***@${domain}`;
}

export function maskPhone(phone: string | null): string | null {
  if (!phone) return null;
  if (phone.length <= 5) return "***";
  return `${phone.slice(0, 3)}***${phone.slice(-2)}`;
}

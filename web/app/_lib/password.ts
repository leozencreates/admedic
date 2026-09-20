import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import { promisify } from "node:util";
const scrypt = promisify(scryptCallback);
export const tokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const key = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt:${salt}:${key.toString("hex")}`;
}
export async function verifyPassword(password: string, encoded: string | null) {
  const match = /^scrypt:([a-f0-9]{32}):([a-f0-9]{128})$/.exec(encoded ?? "");
  // Unknown accounts still perform an equally expensive derivation.
  const key = (await scrypt(
    password,
    match?.[1] ?? "00000000000000000000000000000000",
    64,
  )) as Buffer;
  return !!match && timingSafeEqual(key, Buffer.from(match[2], "hex"));
}

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { prisma } from "@admedic/database";

/**
 * OAuth state yardımcıları — oturuma bağlı, süreli ve tek kullanımlık state.
 * State HMAC-SHA256 ile imzalanır (AUTH_SECRET); callback'te nonce tek kullanımlık
 * olarak RequestQuota tablosunda tüketilir (CSRF/replay koruması).
 */

const STATE_TTL_MS = 10 * 60 * 1000;

export interface OAuthStatePayload {
  v: 1;
  nonce: string;
  userId: string;
  orgId: string;
  exp: number; // epoch ms
}

export function signOAuthState(payload: OAuthStatePayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("hex");
  return `${body}.${sig}`;
}

export function createOAuthState(
  secret: string,
  userId: string,
  orgId: string,
): { state: string; payload: OAuthStatePayload } {
  const nonce = randomBytes(24).toString("hex");
  const payload: OAuthStatePayload = {
    v: 1,
    nonce,
    userId,
    orgId,
    exp: Date.now() + STATE_TTL_MS,
  };
  return { state: signOAuthState(payload, secret), payload };
}

export function parseOAuthState(
  state: string,
  secret: string,
  now = Date.now(),
): OAuthStatePayload | null {
  const dot = state.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(sig, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as OAuthStatePayload;
    if (
      payload.v !== 1 ||
      typeof payload.nonce !== "string" ||
      typeof payload.userId !== "string" ||
      typeof payload.orgId !== "string" ||
      typeof payload.exp !== "number"
    ) {
      return null;
    }
    if (payload.exp <= now) return null;
    return payload;
  } catch {
    return null;
  }
}

export class OAuthStateUsedError extends Error {
  constructor() {
    super("OAuth isteği zaten işlenmiş.");
  }
}

export function isOAuthStateUsedError(e: unknown): boolean {
  return e instanceof OAuthStateUsedError;
}

/**
 * Nonce'ı tek kullanımlık olarak işaretler. Aynı nonce tekrar gelirse bozulur.
 */
export async function consumeOAuthState(
  orgId: string,
  nonce: string,
): Promise<void> {
  try {
    await prisma.requestQuota.create({
      data: {
        key: `oauth:${orgId}:${nonce}`,
        count: 1,
        expiresAt: new Date(Date.now() + STATE_TTL_MS),
      },
    });
  } catch (e) {
    if ((e as { code?: string })?.code === "P2002") throw new OAuthStateUsedError();
    throw e;
  }
}
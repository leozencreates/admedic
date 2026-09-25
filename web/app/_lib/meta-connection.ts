import { prisma } from "@admedic/database";
import { loadEnv } from "@admedic/config";
import {
  exchangeUserToken,
  getAppAccessToken,
  getTokenDebug,
} from "@admedic/meta-api";
import { HttpError } from "./http";
import { decrypt, encrypt } from "./encrypt";
import { requiredScopesMissing } from "./meta-scopes";

/**
 * Süresi dolmadan önce token'ı yenilemeye çalışmak için eşik.
 * Meta belgelerinde uzun ömürlü token ~60 gün geçerlidir; eşik altında kalan
 * bağlantılar otomatik yenilenmeye aday kabul edilir.
 */
export const META_REFRESH_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

export interface LiveMetaConnectionResult {
  connectionId: string;
  token: string;
  mockMode: boolean;
  expiresAt: Date | null;
}

/**
 * Meta çağrısı yapmadan önce bağlantıyı doğrular: durum, token varlığı ve
 * süre. Süre eşiğin altında ise sessizce yenilemeyi dener (başarısızlığı yut;
 * asıl çağrı yine de gider). spec 3.1: "Token süresi dolmadan yenileme".
 */
export async function requireLiveMetaConnection(
  connId: string,
  orgId: string,
): Promise<LiveMetaConnectionResult> {
  const conn = await prisma.metaConnection.findUnique({ where: { id: connId } });
  if (!conn || conn.orgId !== orgId)
    throw new HttpError(400, "Meta bağlantısı bulunamadı.");
  if (conn.status !== "CONNECTED")
    throw new HttpError(
      conn.status === "EXPIRED"
        ? 400
        : conn.status === "REVOKED"
          ? 401
          : 400,
      "Meta bağlantısı aktif değil. Bağlantı sayfasından yenileyin.",
    );
  const env = loadEnv();
  if (env.META_MOCK_MODE)
    return {
      connectionId: conn.id,
      token: "mock-token",
      mockMode: true,
      expiresAt: conn.expiresAt,
    };
  if (!conn.tokenCiphertext)
    throw new HttpError(400, "Meta erişim token'ı bulunamadı.");
  if (conn.expiresAt && conn.expiresAt.getTime() <= Date.now())
    throw new HttpError(
      400,
      "Meta erişim token'ının süresi doldu. Bağlantı sayfasından yenileyin.",
    );
  let current = conn;
  if (conn.expiresAt && conn.expiresAt.getTime() - Date.now() < META_REFRESH_WINDOW_MS) {
    try {
      await refreshMetaConnection(conn.id, { updateIfHealthy: true });
      current = await prisma.metaConnection.findUniqueOrThrow({
        where: { id: conn.id },
      });
    } catch {
      // Best-effort: yenileme başarısız olsa da çağrı devam eder.
    }
  }
  return {
    connectionId: current.id,
    token: decrypt(current.tokenCiphertext ?? ""),
    mockMode: false,
    expiresAt: current.expiresAt,
  };
}

export interface RefreshMetaResult {
  refreshed: boolean;
  status: string;
  expiresAt: Date | null;
  missingPermissions: string[];
}

/**
 * Meta token'ını yeniler: debug_token ile durumu doğrular, ardından
 * `fb_exchange_token` ile yeni uzun ömürlü token üretir (belgelenmiş kural:
 * yalnızca süresi dolmamış token yenilenebilir).
 */
export async function refreshMetaConnection(
  connId: string,
  opts: { updateIfHealthy?: boolean } = {},
): Promise<RefreshMetaResult> {
  const env = loadEnv();
  if (!env.META_APP_ID || !env.META_APP_SECRET)
    throw new HttpError(400, "Token yenileme için META_APP_ID/META_APP_SECRET ayarlanmamış.");
  if (env.META_MOCK_MODE) {
    const mock = await prisma.metaConnection.update({
      where: { id: connId },
      data: { status: "CONNECTED", lastError: null },
    });
    return {
      refreshed: true,
      status: mock.status,
      expiresAt: mock.expiresAt,
      missingPermissions: [],
    };
  }
  const conn = await prisma.metaConnection.findUnique({ where: { id: connId } });
  if (!conn) throw new HttpError(404, "Meta bağlantısı bulunamadı.");
  if (!conn.tokenCiphertext)
    throw new HttpError(400, "Saklı token bulunamadı; yeniden bağlanın.");
  if (conn.expiresAt && conn.expiresAt.getTime() <= Date.now())
    throw new HttpError(
      409,
      "Süresi dolmuş Meta token'ı yenilenemez (Meta kuralı); bağlantıyı yeniden kurun.",
    );

  const currentToken = decrypt(conn.tokenCiphertext);
  const debug = await getTokenDebug(currentToken, getAppAccessToken());
  if (debug.isValid === false)
    throw new HttpError(
      409,
      debug.error
        ? `Meta token'ı geçersiz: ${debug.error}`
        : "Meta token'ı geçersiz veya iptal edilmiş.",
    );

  const exchanged = await exchangeUserToken(currentToken);
  const missingPermissions = requiredScopesMissing(debug.scopes);
  const nextExpiresAt =
    exchanged.expiresAt ??
    (debug.expiresAt ? (debug.expiresAt.getTime() > Date.now() ? debug.expiresAt : null) : null);

  const data = {
    tokenCiphertext: encrypt(exchanged.accessToken),
    expiresAt: nextExpiresAt,
    scopes: debug.scopes?.length > 0 ? debug.scopes : conn.scopes,
    missingPermissions,
    status: "CONNECTED" as const,
    lastError: null as string | null,
  };
  const updated = await prisma.metaConnection.update({ where: { id: conn.id }, data });
  return {
    refreshed: true,
    status: updated.status,
    expiresAt: updated.expiresAt,
    missingPermissions,
  };
}
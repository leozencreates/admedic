import { loadEnv } from "@admedic/config";
import { AdmedicError } from "@admedic/shared";
import { getGraphVersion, rawGraph } from "./http";

function graphUrl(version: string, path: string, params: Record<string, string>) {
  const url = new URL(`https://graph.facebook.com/${version}/${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") url.searchParams.set(k, v);
  }
  return url.toString();
}

export interface TokenDebugResult {
  isValid: boolean;
  expiresAt: Date | null;
  scopes: string[];
  userId: string | null;
  appId: string | null;
  error?: string;
}

/**
 * `GET /{version}/debug_token` — token'ın geçerlilik durumunu, son kullanma
 * zamanını ve izinlerini döndürür. `accessToken`, input token'ı üreten app'e
 * ait bir app access token (`{app_id}|{app_secret}`) olmalıdır.
 */
export async function getTokenDebug(
  inputToken: string,
  appToken: string,
  options: { version?: string; fetchFn?: typeof fetch } = {},
): Promise<TokenDebugResult> {
  const version = getGraphVersion(options.version);
  const url = graphUrl(version, "debug_token", {
    input_token: inputToken,
    access_token: appToken,
  });
  const res = await rawGraph(url.toString(), options.fetchFn ?? fetch);
  const data = (res.body as { data?: Record<string, unknown> })?.data ?? {};
  const expires =
    typeof data.expires_at === "number" ? new Date(data.expires_at * 1000) : null;
  const scopes = Array.isArray(data.scopes)
    ? data.scopes.map(String)
    : [];
  const error =
    data.error !== undefined
      ? String(isRecord(data.error) ? data.error.message ?? data.error : data.error)
      : undefined;
  return {
    isValid: typeof data.is_valid === "boolean" ? data.is_valid : false,
    expiresAt: expires,
    scopes,
    userId: data.user_id !== undefined ? String(data.user_id) : null,
    appId: data.app_id !== undefined ? String(data.app_id) : null,
    ...(error ? { error } : {}),
  };
}

export interface ExchangeUserTokenResult {
  accessToken: string;
  expiresAt: Date | null;
}

/**
 * Yeni kullanıcı token'ı üretir: `GET oauth/access_token?grant_type=fb_exchange_token`.
 * Kaynak: developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived
 * Kurallar: yalnızca GEÇERLİ (süresi dolmamış) token yenilenebilir; süresi
 * dolmuşsa kullanıcı OAuth akışını yeniden yürütmek zorunda kalır. Dönen token
 * öncekinden farklı bir string'dir; eski tokendağ değiştirilmelidir.
 */
export async function exchangeUserToken(
  currentToken: string,
  options: { version?: string; fetchFn?: typeof fetch } = {},
): Promise<ExchangeUserTokenResult> {
  const env = loadEnv();
  if (!env.META_APP_ID || !env.META_APP_SECRET)
    throw new AdmedicError(
      "META_API_ERROR",
      "Token yenileme için META_APP_ID ve META_APP_SECRET gereklidir.",
    );
  const version = getGraphVersion(options.version);
  const url = graphUrl(version, "oauth/access_token", {
    grant_type: "fb_exchange_token",
    client_id: env.META_APP_ID,
    client_secret: env.META_APP_SECRET,
    fb_exchange_token: currentToken,
  });
  const res = await rawGraph(url.toString(), options.fetchFn ?? fetch);
  const body = isRecord(res.body) ? res.body : {};
  const accessToken =
    typeof body.access_token === "string" ? body.access_token : null;
  if (!accessToken) {
    throw new AdmedicError(
      "META_API_ERROR",
      "Meta token değişimi yeni erişim token'ı döndürmedi.",
    );
  }
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : undefined;
  return {
    accessToken,
    expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000) : null,
  };
}

/** App access token (`{app_id}|{app_secret}`) oluşturur; sunucu tarafında kullanılır. */
export function getAppAccessToken(): string {
  const env = loadEnv();
  if (!env.META_APP_ID || !env.META_APP_SECRET) {
    throw new AdmedicError(
      "META_API_ERROR",
      "App access token için META_APP_ID ve META_APP_SECRET gereklidir.",
    );
  }
  return `${env.META_APP_ID}|${env.META_APP_SECRET}`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
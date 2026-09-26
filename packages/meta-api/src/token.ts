import { createHmac } from "node:crypto";
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

/**
 * `appsecret_proof` = HMAC-SHA256(access_token, app_secret) (hex). "Require App
 * Secret" açık uygulamalarda sunucu tarafı Graph çağrılarında zorunludur; secret
 * yoksa `undefined` döner ve parametre gönderilmez.
 * Kaynak: developers.facebook.com/docs/graph-api/guides/secure-requests
 * (2026-09-26 kontrol edildi; bkz. docs/meta-constraints.md).
 */
export function appSecretProof(accessToken: string, appSecret?: string): string | undefined {
  const secret = appSecret ?? loadEnv().META_APP_SECRET;
  if (!secret) return undefined;
  return createHmac("sha256", secret).update(accessToken).digest("hex");
}

export interface GraphAuth {
  /** Token `Authorization: Bearer` başlığında taşınır (URL/log sızıntısı yok). */
  headers: { Authorization: string };
  /** Varsa `appsecret_proof` sorgu parametresi. */
  params: Record<string, string>;
}

/** Kullanıcı/sayfa token'ı ile yetkili Graph isteği için başlık + parametreler. */
export function graphAuth(accessToken: string, appSecret?: string): GraphAuth {
  const proof = appSecretProof(accessToken, appSecret);
  return {
    headers: { Authorization: `Bearer ${accessToken}` },
    params: proof ? { appsecret_proof: proof } : {},
  };
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
 * zamanını ve izinlerini döndürür. `appToken`, input token'ı üreten app'e ait bir
 * app access token (`{app_id}|{app_secret}`) olmalıdır ve `Authorization: Bearer`
 * başlığıyla gönderilir; incelenen token (`input_token`) uç tanımı gereği sorgu
 * parametresidir.
 */
export async function getTokenDebug(
  inputToken: string,
  appToken: string,
  options: { version?: string; fetchFn?: typeof fetch } = {},
): Promise<TokenDebugResult> {
  const version = getGraphVersion(options.version);
  const url = graphUrl(version, "debug_token", { input_token: inputToken });
  const res = await rawGraph(url.toString(), options.fetchFn ?? fetch, {
    method: "GET",
    headers: { Authorization: `Bearer ${appToken}` },
  });
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
 * öncekinden farklı bir string'dir; eski token değiştirilmelidir.
 * Not: `fb_exchange_token` değiştirilen token'ın kendisidir ve uç tanımı gereği
 * sorgu parametresi olarak gider (başlık alternatifi belgelenmemiştir).
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

export interface GrantedPermissionsResult {
  /** `status: "granted"` olan izinler. */
  granted: string[];
  /** `status: "declined"` olan izinler (kullanıcı reddetti; `auth_type=rerequest` gerekir). */
  declined: string[];
  /** `status: "expired"` olan izinler. */
  expired: string[];
}

/**
 * Mock modda "verilmiş" sayılan izinler: Business Login'de istenen tam set.
 * Web katmanı (`meta-scopes.ts`) kendi listesini `mockGranted` ile geçebilir.
 */
export const MOCK_GRANTED_PERMISSIONS: readonly string[] = [
  "business_management",
  "ads_management",
  "ads_read",
  "pages_show_list",
  "pages_manage_metadata",
  "pages_messaging",
  "leads_retrieval",
  "instagram_basic",
  "instagram_manage_messages",
  "whatsapp_business_messaging",
  "whatsapp_business_management",
];

export interface GrantedPermissionsOptions {
  version?: string;
  fetchFn?: typeof fetch;
  /** META_MOCK_MODE override'ı (test için). */
  mock?: boolean;
  /** Mock modda dönecek izin listesi (varsayılan: MOCK_GRANTED_PERMISSIONS). */
  mockGranted?: readonly string[];
  /** appsecret_proof için secret (varsayılan: META_APP_SECRET). */
  appSecret?: string;
}

/**
 * `GET /{version}/me/permissions` — kullanıcının uygulamaya verdiği izinler.
 * Yanıt: `{ data: [{ permission, status: "granted" | "declined" | "expired" }] }`.
 * Kod değişimi (`oauth/access_token`) yanıtında `granted_scopes` GELMEZ; eksik
 * izin hesabı bu uçla yapılır. Token `Authorization: Bearer` başlığında,
 * `appsecret_proof` (secret varsa) sorgu parametresindedir.
 * Kaynak: developers.facebook.com/docs/graph-api/reference/user/permissions
 */
export async function getGrantedPermissions(
  accessToken: string,
  options: GrantedPermissionsOptions = {},
): Promise<GrantedPermissionsResult> {
  const env = loadEnv();
  const mock = options.mock ?? env.META_MOCK_MODE;
  if (mock) {
    return {
      granted: [...(options.mockGranted ?? MOCK_GRANTED_PERMISSIONS)],
      declined: [],
      expired: [],
    };
  }
  const version = getGraphVersion(options.version);
  const auth = graphAuth(accessToken, options.appSecret);
  const fetchFn = options.fetchFn ?? fetch;
  const result: GrantedPermissionsResult = { granted: [], declined: [], expired: [] };
  let url: string | undefined = graphUrl(version, "me/permissions", auth.params);
  for (let page = 0; url && page < 5; page++) {
    const res = await rawGraph(url, fetchFn, { method: "GET", headers: auth.headers });
    const body = isRecord(res.body) ? res.body : {};
    const rows = Array.isArray(body.data) ? body.data : [];
    for (const row of rows) {
      if (!isRecord(row) || typeof row.permission !== "string") continue;
      const status = typeof row.status === "string" ? row.status : "";
      if (status === "granted") result.granted.push(row.permission);
      else if (status === "declined") result.declined.push(row.permission);
      else if (status === "expired") result.expired.push(row.permission);
    }
    const paging = isRecord(body.paging) ? body.paging : {};
    url = typeof paging.next === "string" ? paging.next : undefined;
  }
  return result;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

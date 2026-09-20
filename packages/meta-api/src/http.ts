import { AdmedicError, isAdmedicError } from "@admedic/shared";
import { loadEnv } from "@admedic/config";

import type { MetaApiErrorShape, MetaPagedResponse } from "./types";

const GRAPH_BASE = "https://graph.facebook.com";

export interface GraphErrorDetail {
  code?: number;
  subcode?: number;
  message: string;
  fbtraceId?: string;
}

export class MetaGraphError extends AdmedicError {
  readonly detail: GraphErrorDetail;

  constructor(detail: GraphErrorDetail) {
    super("META_API_ERROR", detail.message || "Meta API hatası", {
      code: detail.code,
      subcode: detail.subcode,
      fbtrace_id: detail.fbtraceId,
    });
    this.detail = detail;
  }
}

/** Meta hata yükünü normalize eder: { error: { code, message, error_subcode, ... } }. */
export function parseMetaError(body: unknown): GraphErrorDetail {
  const err = (
    isRecord(body) && isRecord(body.error)
      ? body.error
      : isRecord(body)
        ? body
        : {}
  ) as MetaApiErrorShape;
  const code = typeof err.code === "number" ? err.code : undefined;
  const subcode =
    typeof err.error_subcode === "number" ? err.error_subcode : undefined;
  const message =
    typeof err.error_user_msg === "string" && err.error_user_msg.length > 0
      ? err.error_user_msg
      : typeof err.message === "string"
        ? err.message
        : "Meta API bilinmeyen hata";
  return { code, subcode, message, fbtraceId: err.fbtrace_id };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function graphUrl(
  version: string,
  path: string,
  params: Record<string, string>,
): string {
  const url = new URL(`${GRAPH_BASE}/${version}/${path.replace(/^\//, "")}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") url.searchParams.set(k, v);
  }
  return url.toString();
}

export interface RawResponse {
  body: unknown;
  status: number;
  throttle?: string;
}

/**
 * Graph API'ye GET isteği; sayfalama kapatan (paging.next) ve hataları
 * `MetaGraphError`'e çeviren taşıyıcı.
 */
export async function graphGet<T>(
  version: string,
  path: string,
  params: Record<string, string>,
  fetchFn: typeof fetch = fetch,
  maxPages = 5,
): Promise<T[]> {
  const rows: T[] = [];
  let url = graphUrl(version, path, params);

  for (let page = 0; page < maxPages; page++) {
    const res = await rawGraph(url, fetchFn);
    const paged = res.body as MetaPagedResponse<T>;
    if (isRecord(paged) && Array.isArray(paged.data)) {
      rows.push(...paged.data);
    } else {
      rows.push(paged as unknown as T);
      return rows;
    }
    const next =
      isRecord(paged) && isRecord(paged.paging) ? paged.paging.next : undefined;
    if (!next) break;
    url = next;
  }
  return rows;
}

/** Tek Graph isteği; Meta hata şemasını ve ağ hatalarını çevirir. */
export async function rawGraph(
  urlOrPath: string,
  fetchFn: typeof fetch = fetch,
  init?: RequestInit,
): Promise<RawResponse> {
  const res = await wrappedFetch(urlOrPath, fetchFn, init);
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (isRecord(body) && body.error) {
    throw new MetaGraphError(parseMetaError(body));
  }
  if (!res.ok) {
    // Meta HTML/boş hata dönerse yine de kullanıcıya ilet.
    const msg =
      isRecord(body) && typeof body.message === "string"
        ? String(body.message)
        : res.statusText;
    throw new MetaGraphError({
      code: res.status,
      message: `Meta API HTTP ${res.status}: ${msg}`,
    });
  }
  return {
    body,
    status: res.status,
    throttle: res.headers.get("x-fb-ads-insights-throttle") ?? undefined,
  };
}

async function wrappedFetch(
  url: string,
  fetchFn: typeof fetch,
  init?: RequestInit,
): Promise<Response> {
  try {
    return await fetchFn(url, init);
  } catch (e) {
    if (isAdmedicError(e)) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    throw new AdmedicError("NETWORK_ERROR", `Meta API'ye ulaşılamadı: ${msg}`);
  }
}

/** Form-encoded POST (Meta güncelleme uçları için). */
export async function graphPost(
  version: string,
  path: string,
  data: Record<string, string | number | undefined>,
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<unknown> {
  const url = graphUrl(version, path, {});
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined && v !== null) body.set(k, String(v));
  }
  body.set("access_token", token);
  const res = await rawGraph(url, fetchFn, {
    method: "POST",
    body,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  return res.body;
}

export function getGraphVersion(override?: string): string {
  const env = loadEnv();
  const version = override ?? env.META_API_VERSION;
  if (!/^v\d+\.\d+$/.test(version ?? "")) {
    throw new Error(`Geçersiz META_API_VERSION: '${version}' (örn. v26.0)`);
  }
  return version as string;
}

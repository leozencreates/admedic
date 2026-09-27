import { createHash } from "node:crypto";
import { loadEnv } from "@admedic/config";
import { AdmedicError, mulberry32, seedFromString } from "@admedic/shared";
import { getGraphVersion, rawGraph } from "./http";
import { appSecretProof } from "./secret-proof";

/**
 * Meta Conversions API (spec 3.9): `POST /{version}/{PIXEL_ID}/events`.
 *
 * Kaynaklar (2026-09-26 kontrol edildi; bkz. docs/meta-constraints.md):
 * - developers.facebook.com/docs/marketing-api/conversions-api/using-the-api
 * - developers.facebook.com/docs/marketing-api/conversions-api/parameters (server-event,
 *   customer-information-parameters, custom-data)
 *
 * Kurallar:
 * - `event_time` Unix saniye (tam sayı), en fazla 7 gün geriye.
 * - `event_name` Meta standart adı (Lead, Schedule, CompleteRegistration, Contact, Purchase…);
 *   iç enum (`LEAD`, `SCHEDULE`, …) burada Meta adına eşlenir.
 * - `action_source` yalnızca Meta değerleri.
 * - `user_data`: em/ph/fn/ln/country normalize edilip SHA-256 ile hash'lenir; `ct` (şehir)
 *   ülke için KULLANILMAZ; client_ip_address/client_user_agent hash'lenmez.
 * - `custom_data`: yalnızca `value` ve `currency` (veri minimizasyonu — hizmet, sağlık
 *   durumu, CRM durumu, lead id gönderilmez).
 * - Erişim token'ı `Authorization: Bearer` başlığında (URL/log'a sızmaz).
 * - `META_MOCK_MODE=true` → gerçek istek yok, deterministik yanıt.
 */

/** İç olay türü → Meta standart olay adı (Meta Pixel referansı). */
export const CONVERSION_EVENT_NAMES = {
  LEAD: "Lead",
  SCHEDULE: "Schedule",
  COMPLETE_REGISTRATION: "CompleteRegistration",
  CONTACT: "Contact",
  PURCHASE: "Purchase",
  ADD_TO_CART: "AddToCart",
  INITIATE_CHECKOUT: "InitiateCheckout",
  VIEW_CONTENT: "ViewContent",
  SEARCH: "Search",
  CUSTOMIZE_PRODUCT: "CustomizeProduct",
  ADD_PAYMENT_INFO: "AddPaymentInfo",
  DONATE: "Donate",
  SUBMIT_APPLICATION: "SubmitApplication",
  SUBSCRIBE: "Subscribe",
  START_TRIAL: "StartTrial",
  FIND_LOCATION: "FindLocation",
  ADD_TO_WISHLIST: "AddToWishlist",
} as const;
export type InternalConversionEvent = keyof typeof CONVERSION_EVENT_NAMES;
export type MetaStandardEvent = (typeof CONVERSION_EVENT_NAMES)[InternalConversionEvent];

/**
 * Sağlık turizmi lead akışında Meta'ya gönderilen olaylar (spec 3.9 veri minimizasyonu):
 * yalnızca huni adımlarına karşılık gelen standart olaylar.
 */
const HEALTH_ALLOWED_EVENTS: readonly InternalConversionEvent[] = [
  "LEAD",
  "SCHEDULE",
  "COMPLETE_REGISTRATION",
  "CONTACT",
  "PURCHASE",
];

/** Sağlık kategorisi için izin verilen iç olay türlerini döndürür. */
export function healthAllowedEvents(): InternalConversionEvent[] {
  return [...HEALTH_ALLOWED_EVENTS];
}

/** Meta `action_source` değerleri (server-event parametreleri). */
export const META_ACTION_SOURCES = [
  "website",
  "app",
  "phone_call",
  "chat",
  "email",
  "physical_store",
  "system_generated",
  "business_messaging",
  "other",
] as const;
export type MetaActionSource = (typeof META_ACTION_SOURCES)[number];

export function isMetaActionSource(value: unknown): value is MetaActionSource {
  return typeof value === "string" && (META_ACTION_SOURCES as readonly string[]).includes(value);
}

/** Lead durumu → CAPI olayı (CRM durum geçişinden offline dönüşüm). NEW/LOST için olay yok. */
export const LEAD_STATUS_EVENT: Record<string, InternalConversionEvent | null> = {
  NEW: null,
  CONTACTED: "CONTACT",
  QUALIFIED: "LEAD",
  CONSULTATION_BOOKED: "SCHEDULE",
  TRAVEL_PLANNED: "COMPLETE_REGISTRATION",
  TREATED: "PURCHASE",
  LOST: null,
};

/** İç adı ya da Meta adını Meta standart adına çevirir; bilinmiyorsa null. */
export function toMetaEventName(name: string): MetaStandardEvent | null {
  const internal = (CONVERSION_EVENT_NAMES as Record<string, MetaStandardEvent>)[name.toUpperCase()];
  if (internal) return internal;
  const direct = (Object.values(CONVERSION_EVENT_NAMES) as string[]).find((v) => v === name);
  return (direct as MetaStandardEvent | undefined) ?? null;
}

export interface ConversionUserData {
  /** SHA-256 (normalize edilmiş e-posta). */
  em?: string;
  /** SHA-256 (yalnızca rakam telefon). */
  ph?: string;
  /** SHA-256 (küçük harf ad). */
  fn?: string;
  /** SHA-256 (küçük harf soyad). */
  ln?: string;
  /** SHA-256 (ISO 3166-1 alpha-2 küçük harf ülke). */
  country?: string;
  /** Hash'lenmemiş kararlı kimlik (CRM lookup hash zaten tek yönlü). */
  external_id?: string;
  /** Hash'lenmez. */
  client_ip_address?: string;
  /** Hash'lenmez. */
  client_user_agent?: string;
}

export interface ConversionCustomData {
  value?: number;
  currency?: string;
}

export interface ConversionEventInput {
  /** İç enum (`LEAD`) veya Meta adı (`Lead`). */
  eventName: string;
  /** ISO tarih, Date veya Unix saniye. */
  eventTime: string | number | Date;
  actionSource: MetaActionSource;
  /** Tekilleştirme anahtarı (externalId). */
  eventId: string;
  userData?: ConversionUserData;
  customData?: ConversionCustomData;
  eventSourceURL?: string;
}

export interface MetaConversionResult {
  eventId: string;
  isEventDuplicated: boolean;
}

export interface PostConversionResult {
  data: MetaConversionResult[];
  /** Meta yanıtı: kabul edilen olay sayısı. */
  eventsReceived: number;
  fbtraceId?: string;
  mock: boolean;
}

/** Unix saniye (tam sayı); geçersiz tarih → VALIDATION_ERROR. */
export function toUnixSeconds(value: string | number | Date): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new AdmedicError("VALIDATION_ERROR", "event_time geçersiz.");
    // Milisaniye verilmişse saniyeye indir.
    return Math.floor(value > 1e12 ? value / 1000 : value);
  }
  const d = value instanceof Date ? value : new Date(value);
  const ms = d.getTime();
  if (!Number.isFinite(ms)) throw new AdmedicError("VALIDATION_ERROR", "event_time geçersiz.");
  return Math.floor(ms / 1000);
}

/** Alanı SHA-256 ile hash'ler (hex). */
export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** E-posta: kırp + küçük harf. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Telefon: yalnızca rakam (+, boşluk, parantez yok); "00" uluslararası öneki atılır. */
export function normalizePhone(phone: string): string {
  let digits = phone.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  return digits;
}

/** Ad/soyad: kırp + küçük harf (locale'e bağlı olmayan), noktalama yok. */
export function normalizeName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[.,'"’`\-]/g, "")
    .replace(/\s+/g, " ");
}

/** Ülke: ISO 3166-1 alpha-2, küçük harf; 2 harf değilse null. */
export function normalizeCountry(country: string): string | null {
  const c = country.trim().toLowerCase();
  return /^[a-z]{2}$/.test(c) ? c : null;
}

const ALLOWED_USER_DATA_KEYS = new Set<keyof ConversionUserData>([
  "em", "ph", "fn", "ln", "country", "external_id", "client_ip_address", "client_user_agent",
]);
const ALLOWED_CUSTOM_DATA_KEYS = new Set<keyof ConversionCustomData>(["value", "currency"]);

/**
 * Veri minimizasyonu: `user_data` yalnızca izin verilen anahtarlarla, `custom_data` yalnızca
 * `value`/`currency` ile gider; hizmet, sağlık durumu, lead id vb. asla gönderilmez.
 */
export function sanitizeConversionInput(input: Record<string, unknown>): Record<string, unknown> {
  const allowed = new Set([
    "event_name", "event_time", "action_source", "event_id",
    "user_data", "custom_data", "event_source_url",
  ]);
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (allowed.has(k) && v !== undefined) result[k] = v;
  }
  if (result.user_data && typeof result.user_data === "object") {
    result.user_data = Object.fromEntries(
      Object.entries(result.user_data as Record<string, unknown>).filter(
        ([k, v]) => ALLOWED_USER_DATA_KEYS.has(k as keyof ConversionUserData) && v !== undefined && v !== null && v !== "",
      ),
    );
  }
  if (result.custom_data && typeof result.custom_data === "object") {
    const cd = result.custom_data as Record<string, unknown>;
    const clean: Record<string, unknown> = {};
    for (const key of ALLOWED_CUSTOM_DATA_KEYS) {
      const v = cd[key];
      if (key === "value" && typeof v === "number" && Number.isFinite(v)) clean.value = v;
      if (key === "currency" && typeof v === "string" && /^[A-Za-z]{3}$/.test(v)) clean.currency = v.toUpperCase();
    }
    if (Object.keys(clean).length > 0) result.custom_data = clean;
    else delete result.custom_data;
  }
  return result;
}

/**
 * Kullanıcı verisini Meta kuralına göre hazırlar: em/ph/fn/ln/country normalize + SHA-256.
 * `ct` (şehir) ülke için kullanılmaz. external_id (CRM lookup hash) hash'siz aktarılır.
 */
export function hashUserData(input: {
  email?: string | null;
  phone?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  country?: string | null;
  externalId?: string | null;
  clientIp?: string | null;
  clientUserAgent?: string | null;
}): ConversionUserData {
  const data: ConversionUserData = {};
  if (input.email && input.email.trim()) data.em = sha256(normalizeEmail(input.email));
  if (input.phone) {
    const digits = normalizePhone(input.phone);
    if (digits.length > 0) data.ph = sha256(digits);
  }
  if (input.firstName && normalizeName(input.firstName)) data.fn = sha256(normalizeName(input.firstName));
  if (input.lastName && normalizeName(input.lastName)) data.ln = sha256(normalizeName(input.lastName));
  if (input.country) {
    const c = normalizeCountry(input.country);
    if (c) data.country = sha256(c);
  }
  if (input.externalId && input.externalId.trim()) data.external_id = input.externalId.trim();
  if (input.clientIp && input.clientIp.trim()) data.client_ip_address = input.clientIp.trim();
  if (input.clientUserAgent && input.clientUserAgent.trim()) data.client_user_agent = input.clientUserAgent.trim();
  return data;
}

/** Kararlı olay kimliği: aynı lead+olay+günü tekrar gönderilirse Meta yanıtı eler (idempotente). */
export function eventIdFor({
  prefix,
  leadId,
  eventName,
  date = new Date(),
}: {
  prefix: string;
  leadId: string;
  eventName: string;
  date?: Date;
}): string {
  const day = date.toISOString().slice(0, 10).replace(/-/g, "");
  return `${prefix}_${leadId}_${eventName.toUpperCase()}_${day}`;
}

/** Tek olayı Meta gövdesine çevirir (doğrulama dahil). */
export function buildServerEvent(e: ConversionEventInput): Record<string, unknown> {
  const eventName = toMetaEventName(e.eventName);
  if (!eventName) throw new AdmedicError("VALIDATION_ERROR", `Bilinmeyen olay adı: ${e.eventName}`);
  if (!isMetaActionSource(e.actionSource))
    throw new AdmedicError("VALIDATION_ERROR", `Geçersiz action_source: ${String(e.actionSource)}`);
  if (!e.eventId || !e.eventId.trim()) throw new AdmedicError("VALIDATION_ERROR", "event_id zorunlu.");
  const eventTime = toUnixSeconds(e.eventTime);
  const nowSec = Math.floor(Date.now() / 1000);
  if (eventTime < nowSec - 7 * 86_400)
    throw new AdmedicError("VALIDATION_ERROR", "event_time 7 günden eski olamaz (Meta kuralı).");
  return sanitizeConversionInput({
    event_name: eventName,
    event_time: eventTime,
    action_source: e.actionSource,
    event_id: e.eventId.trim(),
    user_data: e.userData,
    custom_data: e.customData,
    event_source_url: e.eventSourceURL,
  });
}

export interface PostConversionOptions {
  version?: string;
  fetchFn?: typeof fetch;
  /** Yalnızca test; üretimde gönderilmez. */
  testEventCode?: string;
  /** META_MOCK_MODE override'ı (test için). */
  mock?: boolean;
  /**
   * `appsecret_proof` için secret (varsayılan: META_APP_SECRET; boş dize kanıtı kapatır). Token bu uygulamanın
   * OAuth bağlantısından gelir; başka uygulamanın (ör. Events Manager'da üretilen) token'ı kullanılacaksa boş verin.
   */
  appSecret?: string;
}

/**
 * Olayları Pixel/Dataset'e gönderir. Yanıt: `{ events_received, messages, fbtrace_id }`
 * (Meta gövdesi); `data[]` çağıranın verdiği event_id'lerle döner.
 */
export async function postConversionEvents(
  pixelId: string,
  events: ConversionEventInput[],
  token: string,
  options: PostConversionOptions = {},
): Promise<PostConversionResult> {
  if (!pixelId || !/^[A-Za-z0-9_]+$/.test(pixelId.trim()))
    throw new AdmedicError("VALIDATION_ERROR", "Pixel/Dataset ID geçersiz.");
  if (events.length === 0) throw new AdmedicError("VALIDATION_ERROR", "Gönderilecek olay yok.");
  if (events.length > 1000) throw new AdmedicError("VALIDATION_ERROR", "Tek istekte en fazla 1000 olay gönderilebilir.");
  const data = events.map(buildServerEvent);
  const env = loadEnv();
  const mock = options.mock ?? env.META_MOCK_MODE;
  if (mock) {
    // Gerçek istek yok: deterministik, tekrar gönderimde is_event_duplicated=false (Meta'nın
    // gerçek dedup'u pixel tarafındadır; idempotency çağıran tarafta externalId ile sağlanır).
    const seed = seedFromString(`${pixelId}:${events.map((e) => e.eventId).join(",")}`);
    const rnd = mulberry32(seed);
    const trace = Math.floor(rnd() * 0xffffffff).toString(16).padStart(8, "0");
    return {
      data: events.map((e) => ({ eventId: e.eventId, isEventDuplicated: false })),
      eventsReceived: events.length,
      fbtraceId: `mock_${trace}`,
      mock: true,
    };
  }
  if (!token) throw new AdmedicError("AUTH_ERROR", "Meta erişim token'ı yok.");
  const version = getGraphVersion(options.version);
  const proof = appSecretProof(token, options.appSecret);
  const url = `https://graph.facebook.com/${version}/${pixelId.trim()}/events${proof ? `?appsecret_proof=${proof}` : ""}`;
  const body: Record<string, unknown> = { data };
  if (options.testEventCode) body.test_event_code = options.testEventCode;
  const res = await rawGraph(url, options.fetchFn ?? fetch, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const raw = (res.body ?? {}) as { events_received?: unknown; fbtrace_id?: unknown; data?: unknown };
  const eventsReceived = typeof raw.events_received === "number" ? raw.events_received : events.length;
  // Meta bugün olay bazlı dedup bilgisi döndürmez; sağlanırsa (data[]) okunur.
  const perEvent = Array.isArray(raw.data)
    ? (raw.data as Array<{ event_id?: unknown; is_event_duplicated?: unknown }>)
    : [];
  return {
    data: events.map((e, i) => ({
      eventId: e.eventId,
      isEventDuplicated: perEvent[i]?.is_event_duplicated === true,
    })),
    eventsReceived,
    fbtraceId: typeof raw.fbtrace_id === "string" ? raw.fbtrace_id : undefined,
    mock: false,
  };
}

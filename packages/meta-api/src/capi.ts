import { createHash } from "node:crypto";
import { loadEnv } from "@admedic/config";
import { AdmedicError } from "@admedic/shared";
import { getGraphVersion, rawGraph } from "./http";

/**
 * Meta Conversions API: `POST /{version}/{adAccountId}/events`.
 *
 * Sağlık kategorisi kısıtlamaları (spec 3.9): yalnızca
 * HEALTH_ALLOWED_EVENTS gönderilir; kullanıcı verisi (em/ph)
 * şifrelenmiş hash olarak Meta'ya ulaşır; işlem türü, sağlık
 * durumu vb. alanlar gönderilmez.
 *
 * Döner: { data: [{ event_id, is_event_duplicated }] }
 */
export interface ConversionEventInput {
  eventName: string;
  eventTime: string; // ISO datetime
  actionSource: string;
  eventId: string; // idempotency key (externalId)
  userData?: {
    em?: string;
    ph?: string;
    ct?: string;
    fn?: string;
    ln?: string;
    external_id?: string;
    client_ip?: string;
    client_user_agent?: string;
  };
  customData?: Record<string, unknown>;
  eventSourceURL?: string;
}

export interface MetaConversionResult {
  eventId: string;
  isEventDuplicated: boolean;
}

export async function postConversionEvents(
  adAccountId: string,
  events: ConversionEventInput[],
  token: string,
  options: { version?: string; fetchFn?: typeof fetch } = {},
): Promise<{ data: MetaConversionResult[] }> {
  const env = loadEnv();
  const version = getGraphVersion(options.version);
  const url = new URL(
    `https://graph.facebook.com/${version}/${adAccountId}/events`,
  );
  url.searchParams.set("access_token", token);
  const body = {
    data: events.map((e) => ({
      event_name: e.eventName,
      event_time: e.eventTime,
      action_source: e.actionSource,
      event_id: e.eventId,
      ...(e.userData ? { user_data: e.userData } : {}),
      ...(e.customData ? { custom_data: e.customData } : {}),
      ...(e.eventSourceURL ? { event_source_url: e.eventSourceURL } : {}),
    })),
  };
  const res = await rawGraph(url.toString(), options.fetchFn ?? fetch, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const raw = ((res.body as { data?: Array<{ event_id: string; is_event_duplicated: boolean }> })?.data ?? []) as Array<{ event_id: string; is_event_duplicated: boolean }>;
  return {
    data: raw.map((d) => ({
      eventId: d.event_id,
      isEventDuplicated: d.is_event_duplicated,
    })),
  };
}

/** Sağlık kategorisi için Meta'nın izin verdiği olay türlerini döndürür. */
export function healthAllowedEvents(): string[] {
  return [
    "PURCHASE",
    "ADD_TO_CART",
    "LEAD",
    "INITIATE_CHECKOUT",
    "COMPLETE_REGISTRATION",
    "CONTENT",
    "VIEW_CONTENT",
    "SEARCH",
    "CUSTOMIZE_PRODUCT",
    "ADD_PAYMENT_INFO",
    "DONATE",
  ];
}

/**
 * Sağlık reklamverenleri için veri minimizasyonu: Meta'ya yalnızca
 * izin verilen alanlar gönderilir. Sağlık durumu, tıbbi bilgi
 * gönderilmez.
 */
export function sanitizeConversionInput(input: Record<string, unknown>): Record<string, unknown> {
  const allowed = new Set([
    "event_name", "event_time", "action_source", "event_id",
    "user_data", "custom_data", "event_source_url",
  ]);
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (allowed.has(k)) result[k] = v;
  }
  if (result.user_data && typeof result.user_data === "object") {
    const ud = result.user_data as Record<string, unknown>;
    const allowedUd = new Set(["em", "ph", "ct", "fn", "ln", "external_id", "client_ip", "client_user_agent"]);
    result.user_data = Object.fromEntries(
      Object.entries(ud).filter(([k]) => allowedUd.has(k)),
    );
  }
  return result;
}

/** E-postayı Meta kuralına göre normalize eder: küçük harf, yalın. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Telefonu Meta kuralına göre normalize eder: + ve rakamlar korunur. */
export function normalizePhone(phone: string): string {
  const digits = phone.replace(/[^\d+]/g, "");
  return digits.length > 0 ? digits : phone.trim();
}

/** Alanı SHA-256 ile hash'ler. */
export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Spec 3.9: Kullanıcı verisini Meta Conversions API için hazırlar — e-posta,
 * telefon ve adlar SHA-256 ile hash'lenir (Meta kuralı: küçük harf/normalize);
 * sağlık verisi gönderilmez. external_id (CRM lookup hash) hash'siz aktarılır.
 */
export function hashUserData(input: {
  email?: string | null;
  phone?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  country?: string | null;
  externalId?: string | null;
}): NonNullable<ConversionEventInput["userData"]> {
  const data: NonNullable<ConversionEventInput["userData"]> = {};
  if (input.email && input.email.trim())
    data.em = sha256(normalizeEmail(input.email));
  if (input.phone && input.phone.trim())
    data.ph = sha256(normalizePhone(input.phone));
  if (input.firstName && input.firstName.trim())
    data.fn = sha256(input.firstName.trim());
  if (input.lastName && input.lastName.trim())
    data.ln = sha256(input.lastName.trim());
  if (input.country && input.country.trim()) data.ct = input.country.trim();
  if (input.externalId && input.externalId.trim())
    data.external_id = input.externalId.trim();
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
  return `${prefix}_${leadId}_${eventName}_${day}`;
}
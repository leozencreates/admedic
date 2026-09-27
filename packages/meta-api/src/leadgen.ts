import { mulberry32, seedFromString } from "@admedic/shared";
import { getGraphVersion, rawGraph } from "./http";
import { LEAD_FORM_CONSENT_KEY } from "./publish";
import { appSecretProof } from "./secret-proof";

/**
 * Meta Lead Ads — lead verisini çekme.
 *
 * Gerçek `leadgen` webhook'u yalnızca kimlik taşır (leadgen_id, page_id, form_id,
 * ad_id, adgroup_id, created_time); form yanıtları
 * `GET /{leadgen_id}?fields=id,created_time,field_data,custom_disclaimer_responses,…`
 * ile sayfa/kullanıcı token'ı üzerinden okunur (`leads_retrieval` izni gerekir).
 * Onay kutusu yanıtları `field_data`'da DEĞİL, açıkça istenmesi gereken `custom_disclaimer_responses`
 * alanındadır (`[{ checkbox_key, is_checked: "1" | "" }]`).
 * Kaynak: developers.facebook.com/docs/marketing-api/guides/lead-ads/retrieving
 * (2026-09-26 / 2026-09-27 kontrol edildi; bkz. docs/meta-constraints.md).
 */

export const LEADGEN_FIELDS =
  "id,created_time,field_data,custom_disclaimer_responses,ad_id,adset_id,campaign_id,form_id,is_organic,platform";

export interface MetaLeadgenFieldData {
  name: string;
  values: string[];
}

/**
 * Standart Meta form alanları normalize edilmiş şekli. PII (e-posta/telefon/ad)
 * yalnızca burada taşınır; çağıran taraf bunları şifreli sütunlara yazar.
 * Diğer sorular (özel sorular, hizmet tercihi vb.) `answers` altında kalır.
 */
export interface NormalizedLeadFields {
  email: string | null;
  phone: string | null;
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
  country: string | null;
  city: string | null;
  /** PII olmayan diğer form yanıtları (soru adı → yanıt). */
  answers: Record<string, string>;
}

/** Instant Form özel onay kutusu yanıtı (`custom_disclaimer_responses[]`). */
export interface LeadDisclaimerResponse {
  /** Formdaki kutu anahtarı (`checkbox_key`; Admedic formlarında `LEAD_FORM_CONSENT_KEY`). */
  key: string;
  /** `is_checked` "1" → true; boş dize → false. */
  checked: boolean;
}

export interface MetaLeadgenData {
  id: string;
  createdTime: string | null;
  adId: string | null;
  adsetId: string | null;
  campaignId: string | null;
  formId: string | null;
  isOrganic: boolean | null;
  platform: string | null;
  fieldData: MetaLeadgenFieldData[];
  normalized: NormalizedLeadFields;
  /**
   * Onay kutusu yanıtları. `null`: kaynak bu bilgiyi taşımıyor (webhook içi `field_data`);
   * boş dizi: Graph yanıtında kutu yok.
   */
  disclaimerResponses: LeadDisclaimerResponse[] | null;
}

/** Standart alan adları → normalize anahtar. Kaynak: Instant Form "prefill questions". */
const EMAIL_KEYS = new Set(["email", "work_email", "e-mail", "e_mail", "eposta", "e-posta"]);
const PHONE_KEYS = new Set([
  "phone_number",
  "work_phone_number",
  "phone",
  "telefon",
  "telefon_numarası",
  "mobile",
]);
const FULL_NAME_KEYS = new Set(["full_name", "name", "ad_soyad", "adınız_soyadınız"]);
const FIRST_NAME_KEYS = new Set(["first_name", "ad", "adınız"]);
const LAST_NAME_KEYS = new Set(["last_name", "soyad", "soyadınız"]);
const COUNTRY_KEYS = new Set(["country", "country_code", "ülke"]);
const CITY_KEYS = new Set(["city", "şehir", "sehir"]);
/** `answers`'a asla yazılmayan diğer standart PII alanları. */
const DROPPED_PII_KEYS = new Set([
  "street_address",
  "zip_code",
  "post_code",
  "date_of_birth",
  "gender",
  "state",
  "province",
  "national_id",
  "id_number",
  "tc_kimlik",
]);

function firstValue(values: string[]): string | null {
  const joined = values
    .map((v) => (typeof v === "string" ? v.trim() : String(v ?? "").trim()))
    .filter((v) => v.length > 0)
    .join(", ");
  return joined.length > 0 ? joined : null;
}

/** Alan adını karşılaştırılabilir anahtara indirger ("Phone Number" → "phone_number"). */
export function normalizeFieldName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

/** `field_data` dizisini standart alanlar + diğer yanıtlar olarak ayırır. */
export function normalizeLeadgenFields(
  fieldData: MetaLeadgenFieldData[],
): NormalizedLeadFields {
  const out: NormalizedLeadFields = {
    email: null,
    phone: null,
    fullName: null,
    firstName: null,
    lastName: null,
    country: null,
    city: null,
    answers: {},
  };
  for (const field of fieldData) {
    if (!field || typeof field.name !== "string") continue;
    const key = normalizeFieldName(field.name);
    const value = firstValue(Array.isArray(field.values) ? field.values : []);
    if (value === null) continue;
    if (EMAIL_KEYS.has(key)) out.email ??= value;
    else if (PHONE_KEYS.has(key)) out.phone ??= value;
    else if (FULL_NAME_KEYS.has(key)) out.fullName ??= value;
    else if (FIRST_NAME_KEYS.has(key)) out.firstName ??= value;
    else if (LAST_NAME_KEYS.has(key)) out.lastName ??= value;
    else if (COUNTRY_KEYS.has(key)) out.country ??= value;
    else if (CITY_KEYS.has(key)) out.city ??= value;
    else if (DROPPED_PII_KEYS.has(key)) continue;
    else out.answers[key] = value.slice(0, 1000);
  }
  if (!out.firstName && out.fullName) {
    const parts = out.fullName.split(/\s+/).filter(Boolean);
    out.firstName = parts[0] ?? null;
    if (!out.lastName) out.lastName = parts.slice(1).join(" ") || null;
  }
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function optionalId(v: unknown): string | null {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function isChecked(value: unknown): boolean {
  if (value === true || value === 1) return true;
  return typeof value === "string" && ["1", "true"].includes(value.trim().toLowerCase());
}

/** `custom_disclaimer_responses` → `{ key, checked }[]` (anahtarsız satırlar atlanır). */
export function parseDisclaimerResponses(value: unknown): LeadDisclaimerResponse[] {
  if (!Array.isArray(value)) return [];
  const out: LeadDisclaimerResponse[] = [];
  for (const row of value) {
    if (!isRecord(row) || typeof row.checkbox_key !== "string" || !row.checkbox_key.trim()) continue;
    out.push({ key: row.checkbox_key.trim().slice(0, 100), checked: isChecked(row.is_checked) });
  }
  return out.slice(0, 20);
}

/** Graph yanıtını (`GET /{leadgen_id}`) normalize eder. */
export function parseLeadgenResponse(body: unknown, leadgenId: string): MetaLeadgenData {
  const data = isRecord(body) ? body : {};
  const rawFields = Array.isArray(data.field_data) ? data.field_data : [];
  const fieldData: MetaLeadgenFieldData[] = rawFields
    .filter((f): f is Record<string, unknown> => isRecord(f) && typeof f.name === "string")
    .map((f) => ({
      name: String(f.name),
      values: Array.isArray(f.values) ? f.values.map((v) => String(v ?? "")) : [],
    }));
  return {
    id: optionalId(data.id) ?? leadgenId,
    createdTime: typeof data.created_time === "string" ? data.created_time : null,
    adId: optionalId(data.ad_id),
    adsetId: optionalId(data.adset_id),
    campaignId: optionalId(data.campaign_id),
    formId: optionalId(data.form_id),
    isOrganic: typeof data.is_organic === "boolean" ? data.is_organic : null,
    platform: typeof data.platform === "string" ? data.platform : null,
    fieldData,
    normalized: normalizeLeadgenFields(fieldData),
    disclaimerResponses: parseDisclaimerResponses(data.custom_disclaimer_responses),
  };
}

export interface LeadgenFetchOptions {
  version?: string;
  fetchFn?: typeof fetch;
  /** `appsecret_proof` için secret (varsayılan: META_APP_SECRET; boş dize kanıtı kapatır). */
  appSecret?: string;
}

/**
 * `GET /{version}/{leadgen_id}?fields=…` — token Authorization başlığında taşınır
 * (URL/log sızıntısı olmaz), `appsecret_proof` (secret varsa) sorgu parametresindedir.
 * Hatalar `MetaGraphError` olarak yükselir.
 */
export async function getLeadgenData(
  leadgenId: string,
  token: string,
  options: LeadgenFetchOptions = {},
): Promise<MetaLeadgenData> {
  const version = getGraphVersion(options.version);
  const url = new URL(
    `https://graph.facebook.com/${version}/${encodeURIComponent(leadgenId)}`,
  );
  url.searchParams.set("fields", LEADGEN_FIELDS);
  const proof = appSecretProof(token, options.appSecret);
  if (proof) url.searchParams.set("appsecret_proof", proof);
  const res = await rawGraph(url.toString(), options.fetchFn ?? fetch, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  return parseLeadgenResponse(res.body, leadgenId);
}

const MOCK_PEOPLE: Array<{ first: string; last: string; country: string; prefix: string; city: string }> = [
  { first: "Anna", last: "Schmidt", country: "DE", prefix: "49151", city: "Berlin" },
  { first: "James", last: "Carter", country: "GB", prefix: "447700", city: "London" },
  { first: "Ayşe", last: "Demir", country: "TR", prefix: "90532", city: "İstanbul" },
  { first: "Olga", last: "Ivanova", country: "RU", prefix: "7916", city: "Moskova" },
  { first: "Fatima", last: "Al Sayed", country: "AE", prefix: "97150", city: "Dubai" },
  { first: "Pierre", last: "Martin", country: "FR", prefix: "336", city: "Paris" },
  { first: "Sanne", last: "de Vries", country: "NL", prefix: "316", city: "Amsterdam" },
  { first: "Kasia", last: "Nowak", country: "PL", prefix: "48500", city: "Warszawa" },
];
const MOCK_TREATMENTS = [
  "Saç ekimi",
  "Dental implant",
  "Rinoplasti",
  "Check-up paketi",
  "Göz lazer",
];

/**
 * META_MOCK_MODE için deterministik sahte lead verisi: aynı leadgen_id her zaman
 * aynı kişiyi üretir (testler ve demo için). Gerçek Graph çağrısı yapılmaz.
 */
export function getLeadgenDataMock(leadgenId: string): MetaLeadgenData {
  const rng = mulberry32(seedFromString(`leadgen:${leadgenId}`));
  const person = MOCK_PEOPLE[Math.floor(rng() * MOCK_PEOPLE.length)]!;
  const treatment = MOCK_TREATMENTS[Math.floor(rng() * MOCK_TREATMENTS.length)]!;
  const digits = String(Math.floor(rng() * 1_000_000)).padStart(6, "0");
  const slug = leadgenId.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(-8) || "lead";
  const fieldData: MetaLeadgenFieldData[] = [
    { name: "email", values: [`${person.first.toLowerCase()}.${slug}@example.invalid`] },
    { name: "phone_number", values: [`+${person.prefix}${digits}`] },
    { name: "first_name", values: [person.first] },
    { name: "last_name", values: [person.last] },
    { name: "country", values: [person.country] },
    { name: "city", values: [person.city] },
    { name: "which_treatment_are_you_interested_in?", values: [treatment] },
  ];
  return {
    id: leadgenId,
    createdTime: new Date(1_700_000_000_000 + Math.floor(rng() * 1e9)).toISOString(),
    adId: `ad_mock_${slug}`,
    adsetId: `adset_mock_${slug}`,
    campaignId: `cmp_mock_${slug}`,
    formId: `form_mock_${slug}`,
    isOrganic: false,
    platform: "fb",
    fieldData,
    normalized: normalizeLeadgenFields(fieldData),
    // Admedic formlarının zorunlu rıza kutusu işaretli gelir (gerçek formda gönderim için zorunludur).
    disclaimerResponses: [{ key: LEAD_FORM_CONSENT_KEY, checked: true }],
  };
}

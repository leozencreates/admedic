/**
 * Meta'ya tam yayın (spec 3.3/3.6): kampanya → ad set → (lead formu) → kreatif → reklam.
 * Bu modül SAF'tır: yalnızca doğrulama ve Graph API istek gövdeleri üretir; ağ çağrısı yapmaz.
 * Oluşturulan her nesne `status=PAUSED`'dır; etkinleştirme ayrı ve yetki kontrollü bir adımdır.
 *
 * Kaynaklar (2026-09-27 kontrol edildi; ayrıntı ve doğrulanmamış noktalar docs/meta-constraints.md):
 * - Ad set oluşturma: developers.facebook.com/docs/marketing-api/reference/ad-account/adsets/
 * - Hedef türü ↔ objective: /docs/marketing-api/adset/destination_type/
 * - Click-to-WhatsApp: /docs/marketing-api/ad-creative/messaging-ads/click-to-whatsapp/
 * - Lead reklamları ve formlar: /docs/marketing-api/guides/lead-ads/create/, /docs/graph-api/reference/page/leadgen_forms/
 * - Locale hedefleme: /docs/marketing-api/audiences/reference/targeting-search (type=adlocale)
 */
import { AdmedicError } from "@admedic/shared";
import { toMetaObjective } from "./client";
import type { MetaOutcomeObjective } from "./types";

/** Uygulama reklam dilleri (ADR-0009). */
export const PUBLISH_LANGUAGES = ["TR", "EN", "DE", "RU", "AR", "FR", "NL", "PL"] as const;
export type PublishLanguage = (typeof PUBLISH_LANGUAGES)[number];
export type PublishConversionMethod = "landing_form" | "instant_form" | "whatsapp" | "instagram_dm";

export function isPublishLanguage(value: string): value is PublishLanguage {
  return (PUBLISH_LANGUAGES as readonly string[]).includes(value);
}

/** Yayına alınamayan yapılandırma (Meta kısıtı veya eksik girdi); 422 döner, Meta'ya istek gitmez. */
export class MetaPublishSpecError extends AdmedicError {
  constructor(message: string) {
    super("INSUFFICIENT_DATA", message);
    this.name = "MetaPublishSpecError";
  }
}

/** Kreatifin yönlendirdiği yer. */
export type DeliveryLink = "LEAD_FORM" | "WHATSAPP" | "WEBSITE";

export interface DeliverySpec {
  objective: MetaOutcomeObjective;
  /** Boşsa Meta varsayılanı (ör. bilinirlik kampanyası). */
  destinationType?: "ON_AD" | "WHATSAPP" | "WEBSITE";
  optimizationGoal: "LEAD_GENERATION" | "CONVERSATIONS" | "LINK_CLICKS" | "REACH";
  billingEvent: "IMPRESSIONS";
  link: DeliveryLink;
  /** Ad set `promoted_object.page_id` gerektirir (lead reklamı, WhatsApp). */
  promotesPage: boolean;
}

const WHATSAPP_OBJECTIVES: ReadonlySet<MetaOutcomeObjective> = new Set([
  "OUTCOME_LEADS",
  "OUTCOME_SALES",
  "OUTCOME_ENGAGEMENT",
  "OUTCOME_TRAFFIC",
]);
const WEBSITE_OBJECTIVES: ReadonlySet<MetaOutcomeObjective> = new Set(["OUTCOME_LEADS", "OUTCOME_SALES", "OUTCOME_TRAFFIC"]);

/**
 * Objective × dönüşüm yöntemi → ad set teslim ayarları. Desteklenmeyen birleşimler Meta'ya
 * gitmeden `MetaPublishSpecError` ile reddedilir.
 *
 * - Instant Form: yalnızca OUTCOME_LEADS + `destination_type=ON_AD` + LEAD_GENERATION.
 * - WhatsApp: `destination_type=WHATSAPP` + CONVERSATIONS (Click-to-WhatsApp belgesindeki objective listesi).
 * - Açılış sayfası: sağlık/wellness reklamverenlerinde web dönüşüm optimizasyonu (OFFSITE_CONVERSIONS)
 *   Meta tarafından kısıtlı olduğundan LINK_CLICKS; bilinirlik kampanyasında REACH.
 * - Instagram DM: INSTAGRAM_DIRECT yalnızca bilinirlik/etkileşim objective'leriyle geçerli; ürün
 *   planlayıcısı bu objective'leri üretmediğinden henüz desteklenmez.
 */
export function resolveDelivery(objective: string, method: string): DeliverySpec {
  let metaObjective: MetaOutcomeObjective;
  try {
    metaObjective = toMetaObjective(objective);
  } catch {
    throw new MetaPublishSpecError(`Desteklenmeyen kampanya hedefi: ${objective}.`);
  }
  switch (method) {
    case "instant_form":
      if (metaObjective !== "OUTCOME_LEADS")
        throw new MetaPublishSpecError(
          "Instant Form (lead reklamı) yalnızca lead hedefiyle yayınlanabilir; hedefi \"Maksimum Dönüşüm\" seçin veya WhatsApp / açılış sayfası yöntemini kullanın.",
        );
      return {
        objective: metaObjective,
        destinationType: "ON_AD",
        optimizationGoal: "LEAD_GENERATION",
        billingEvent: "IMPRESSIONS",
        link: "LEAD_FORM",
        promotesPage: true,
      };
    case "whatsapp":
      if (!WHATSAPP_OBJECTIVES.has(metaObjective))
        throw new MetaPublishSpecError(
          "Click-to-WhatsApp reklamı bilinirlik hedefiyle yayınlanamaz; \"Maksimum Dönüşüm\" veya \"Maksimum ROAS\" hedefini seçin.",
        );
      return {
        objective: metaObjective,
        destinationType: "WHATSAPP",
        optimizationGoal: "CONVERSATIONS",
        billingEvent: "IMPRESSIONS",
        link: "WHATSAPP",
        promotesPage: true,
      };
    case "landing_form":
      if (metaObjective === "OUTCOME_AWARENESS")
        return {
          objective: metaObjective,
          optimizationGoal: "REACH",
          billingEvent: "IMPRESSIONS",
          link: "WEBSITE",
          promotesPage: false,
        };
      if (!WEBSITE_OBJECTIVES.has(metaObjective))
        throw new MetaPublishSpecError("Açılış sayfası yöntemi bu kampanya hedefiyle desteklenmiyor.");
      return {
        objective: metaObjective,
        destinationType: "WEBSITE",
        optimizationGoal: "LINK_CLICKS",
        billingEvent: "IMPRESSIONS",
        link: "WEBSITE",
        promotesPage: false,
      };
    case "instagram_dm":
      throw new MetaPublishSpecError(
        "Instagram DM dönüşümüyle Meta'ya yayın henüz desteklenmiyor (Meta, INSTAGRAM_DIRECT hedefini yalnızca bilinirlik/etkileşim kampanyalarında kabul ediyor). Instant Form veya WhatsApp seçin.",
      );
    default:
      throw new MetaPublishSpecError(`Bilinmeyen dönüşüm yöntemi: ${method}.`);
  }
}

// ---------------------------------------------------------------------------
// Hedefleme
// ---------------------------------------------------------------------------

/** Meta'nın kabul ettiği en yüksek yaş sınırı. */
export const META_MAX_AGE = 65;
/** Sağlık reklamlarında alt yaş sınırı (spec 3.3: 18 yaş altı hedefleme engellenir). */
export const MIN_TARGET_AGE = 18;

export interface AdSetTargetingInput {
  /** ISO 3166-1 alpha-2 ülke kodları. */
  countries: string[];
  /** Meta sayısal locale anahtarları (`search?type=adlocale`); boşsa dil hedeflemesi yapılmaz. */
  localeKeys: number[];
  ageMin: number;
  ageMax: number;
}

export function buildTargeting(input: AdSetTargetingInput): Record<string, unknown> {
  const countries = Array.from(new Set(input.countries.map((c) => c.trim().toUpperCase()))).filter((c) =>
    /^[A-Z]{2}$/.test(c),
  );
  if (countries.length === 0) throw new MetaPublishSpecError("Ad set için en az bir geçerli ülke kodu gerekli.");
  if (!Number.isInteger(input.ageMin) || input.ageMin < MIN_TARGET_AGE)
    throw new MetaPublishSpecError("18 yaş altı hedefleme engellenir.");
  const ageMax = Math.min(META_MAX_AGE, Math.trunc(input.ageMax));
  if (ageMax < input.ageMin) throw new MetaPublishSpecError("Alt yaş sınırı üst yaş sınırını aşamaz.");
  const localeKeys = Array.from(new Set(input.localeKeys.filter((k) => Number.isInteger(k) && k > 0)));
  return {
    geo_locations: { countries },
    age_min: input.ageMin,
    age_max: ageMax,
    ...(localeKeys.length > 0 ? { locales: localeKeys } : {}),
  };
}

/** `search?type=adlocale` arama terimleri; "(All)" kapsayıcı locale varsa tek başına tercih edilir. */
export const AD_LOCALE_QUERIES: Record<PublishLanguage, string> = {
  TR: "Turkish",
  EN: "English",
  DE: "German",
  RU: "Russian",
  AR: "Arabic",
  FR: "French",
  NL: "Dutch",
  PL: "Polish",
};

const JOKE_LOCALE = /upside down|pirate/i;

/**
 * Locale arama sonucundan dil için anahtar(lar) seçer: "<Dil> (All)" varsa yalnızca o; yoksa adı
 * tam eşleşen; yoksa "<Dil> (" ile başlayan tüm bölgesel varyantlar ("Upside Down" gibi şaka
 * locale'ler hariç). Eşleşme yoksa boş dizi (dil hedeflemesi yapılmaz, ülke hedeflemesi kalır).
 */
export function pickLocaleKeys(language: PublishLanguage, results: ReadonlyArray<{ key: number; name: string }>): number[] {
  const base = AD_LOCALE_QUERIES[language].toLowerCase();
  const clean = results.filter((r) => Number.isInteger(r.key) && r.key > 0 && !JOKE_LOCALE.test(r.name));
  const all = clean.find((r) => r.name.trim().toLowerCase() === `${base} (all)`);
  if (all) return [all.key];
  const exact = clean.filter((r) => r.name.trim().toLowerCase() === base);
  if (exact.length > 0) return exact.map((r) => r.key);
  return clean.filter((r) => r.name.trim().toLowerCase().startsWith(`${base} (`)).map((r) => r.key);
}

// ---------------------------------------------------------------------------
// İstek gövdeleri (form-encoded; iç içe nesneler JSON string olarak gider)
// ---------------------------------------------------------------------------

export type GraphBody = Record<string, string | number>;

export interface AdSetBodyInput {
  campaignId: string;
  name: string;
  delivery: DeliverySpec;
  targeting: AdSetTargetingInput;
  /** ABO: ad set günlük bütçesi (minor unit, ADR-0011). CBO'da verilmez (bütçe kampanyadadır). */
  dailyBudgetCents?: number | null;
  pageId?: string;
}

export function buildAdSetBody(input: AdSetBodyInput): GraphBody {
  const { delivery } = input;
  if (delivery.promotesPage && !input.pageId)
    throw new MetaPublishSpecError("Bu reklam türü için Facebook Sayfası gerekli.");
  const abo = input.dailyBudgetCents != null;
  if (abo && (!Number.isInteger(input.dailyBudgetCents) || (input.dailyBudgetCents as number) <= 0))
    throw new MetaPublishSpecError("ABO ad set'inin günlük bütçesi pozitif olmalı.");
  return {
    name: input.name.slice(0, 400),
    campaign_id: input.campaignId,
    status: "PAUSED",
    billing_event: delivery.billingEvent,
    optimization_goal: delivery.optimizationGoal,
    ...(delivery.destinationType ? { destination_type: delivery.destinationType } : {}),
    ...(delivery.promotesPage ? { promoted_object: JSON.stringify({ page_id: input.pageId }) } : {}),
    targeting: JSON.stringify(buildTargeting(input.targeting)),
    // ABO: bütçe + teklif stratejisi ad set'te. CBO'da ikisi de kampanya seviyesindedir (Meta notu).
    ...(abo ? { daily_budget: input.dailyBudgetCents as number, bid_strategy: "LOWEST_COST_WITHOUT_CAP" } : {}),
  };
}

/** Lead formu reklamlarında belgelenen CTA türleri (lead-ads/create). */
export const LEAD_FORM_CTA_TYPES = ["SIGN_UP", "APPLY_NOW", "GET_QUOTE", "LEARN_MORE", "SUBSCRIBE", "DOWNLOAD"] as const;
/** Web sitesi bağlantılı reklamlarda kullanılan CTA alt kümesi (docs/meta-constraints.md, W7). */
export const WEBSITE_CTA_TYPES = ["LEARN_MORE", "SIGN_UP", "BOOK_NOW", "CONTACT_US", "GET_QUOTE", "APPLY_NOW"] as const;
/**
 * Metni değiştiren Advantage+ kreatif özellikleri (çoğu varsayılan olarak açık). Onaylı sağlık metni
 * politika kontrolünden geçtiği için Meta'nın metni yeniden yazması/eklemesi kapatılır. `standard_enhancements`
 * paketi v22.0'da kaldırıldığından özellikler tek tek bildirilir (ad-creative-features-spec).
 */
export const TEXT_ALTERING_CREATIVE_FEATURES = ["text_optimizations", "description_automation", "add_text_overlay"] as const;

/** Lead reklamı kreatif bağlantısı: Meta sayfa URL'si değil `fb.me` yer tutucusu ister. */
export const LEAD_AD_LINK = "http://fb.me/";
/** Click-to-WhatsApp kreatif bağlantısı. */
export const WHATSAPP_AD_LINK = "https://api.whatsapp.com/send";

export interface AdCreativeBodyInput {
  name: string;
  pageId: string;
  delivery: DeliverySpec;
  imageHash: string;
  headline: string;
  text: string;
  description?: string;
  /** Taslaktaki CTA (Meta türü veya eski serbest metin); yönteme uygun türe indirgenir. */
  cta: string;
  leadFormId?: string;
  landingUrl?: string;
}

function pickCta(cta: string, allowed: readonly string[]): string {
  const normalized = cta.trim().toUpperCase();
  return allowed.includes(normalized) ? normalized : "LEARN_MORE";
}

export function buildAdCreativeBody(input: AdCreativeBodyInput): GraphBody {
  if (!input.pageId) throw new MetaPublishSpecError("Kreatif için Facebook Sayfası gerekli.");
  if (!input.imageHash) throw new MetaPublishSpecError("Reklam görseli yüklenmedi.");
  let link: string;
  let callToAction: Record<string, unknown>;
  switch (input.delivery.link) {
    case "LEAD_FORM":
      if (!input.leadFormId) throw new MetaPublishSpecError("Lead formu oluşturulmadan lead reklamı kreatifi oluşturulamaz.");
      link = LEAD_AD_LINK;
      callToAction = { type: pickCta(input.cta, LEAD_FORM_CTA_TYPES), value: { lead_gen_form_id: input.leadFormId } };
      break;
    case "WHATSAPP":
      link = WHATSAPP_AD_LINK;
      callToAction = { type: "WHATSAPP_MESSAGE", value: { app_destination: "WHATSAPP" } };
      break;
    case "WEBSITE": {
      if (!input.landingUrl) throw new MetaPublishSpecError("Açılış sayfası URL'si gerekli.");
      link = input.landingUrl;
      callToAction = { type: pickCta(input.cta, WEBSITE_CTA_TYPES), value: { link: input.landingUrl } };
      break;
    }
  }
  const linkData: Record<string, unknown> = {
    name: input.headline,
    message: input.text,
    ...(input.description ? { description: input.description } : {}),
    link,
    image_hash: input.imageHash,
    call_to_action: callToAction,
  };
  return {
    name: input.name.slice(0, 100),
    object_story_spec: JSON.stringify({ page_id: input.pageId, link_data: linkData }),
    degrees_of_freedom_spec: JSON.stringify({
      creative_features_spec: Object.fromEntries(
        TEXT_ALTERING_CREATIVE_FEATURES.map((feature) => [feature, { enroll_status: "OPT_OUT" }]),
      ),
    }),
  };
}

export function buildAdBody(input: { name: string; adSetId: string; creativeId: string }): GraphBody {
  return {
    name: input.name.slice(0, 400),
    adset_id: input.adSetId,
    creative: JSON.stringify({ creative_id: input.creativeId }),
    status: "PAUSED",
  };
}

/** Lead formu locale enum'u (leadgen_forms `locale`). */
export const LEAD_FORM_LOCALES: Record<PublishLanguage, string> = {
  TR: "TR_TR",
  EN: "EN_US",
  DE: "DE_DE",
  RU: "RU_RU",
  AR: "AR_AR",
  FR: "FR_FR",
  NL: "NL_NL",
  PL: "PL_PL",
};

/** Formun zorunlu rıza kutusunun anahtarı; gelen lead'lerde `custom_disclaimer_responses` ile eşlenir. */
export const LEAD_FORM_CONSENT_KEY = "kvkk_consent";

export interface LeadFormBodyInput {
  name: string;
  language: PublishLanguage;
  /** Taslağın Instant Form soruları (CUSTOM); ad/telefon/e-posta standart soruları her zaman eklenir. */
  customQuestions: string[];
  privacyPolicyUrl: string;
  privacyLinkText: string;
  consent: { title: string; body: string; checkboxText: string };
}

export function buildLeadFormBody(input: LeadFormBodyInput): GraphBody {
  let url: URL;
  try {
    url = new URL(input.privacyPolicyUrl);
  } catch {
    throw new MetaPublishSpecError("Gizlilik politikası URL'si geçersiz.");
  }
  if (url.protocol !== "https:") throw new MetaPublishSpecError("Gizlilik politikası URL'si https olmalı.");
  const custom = input.customQuestions
    .map((q) => q.trim())
    .filter(Boolean)
    .slice(0, 8)
    .map((label, i) => ({ type: "CUSTOM", key: `question_${i + 1}`, label: label.slice(0, 200) }));
  const questions = [{ type: "FULL_NAME" }, { type: "PHONE" }, { type: "EMAIL" }, ...custom];
  return {
    name: input.name.slice(0, 200),
    locale: LEAD_FORM_LOCALES[input.language],
    questions: JSON.stringify(questions),
    privacy_policy: JSON.stringify({ url: url.toString(), link_text: input.privacyLinkText.slice(0, 70) }),
    custom_disclaimer: JSON.stringify({
      title: input.consent.title.slice(0, 60),
      body: { text: input.consent.body.slice(0, 2000) },
      checkboxes: [
        {
          key: LEAD_FORM_CONSENT_KEY,
          text: input.consent.checkboxText.slice(0, 200),
          is_required: true,
          is_checked_by_default: false,
        },
      ],
    }),
  };
}

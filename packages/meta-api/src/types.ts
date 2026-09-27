/**
 * Meta Marketing API tipleri — ham Graph API yanıtlarının normalize edilmiş şekli.
 * Insight tutarları (spend, cpc, cpm, action_values) "major" (birim) olarak döner;
 * bütçe alanları (`daily_budget`, `lifetime_budget`) Meta'da hesabın minor unit'i
 * (cent/kuruş) olduğundan `…Cents` adıyla ve dönüşümsüz taşınır (ADR-0011,
 * docs/meta-constraints.md "Bütçe (daily_budget) birimi").
 * Kaynak: developers.facebook.com/docs/marketing-api (v26.0, 2026-09-16 kontrol edildi).
 */

export type MetaEntityStatus = "ACTIVE" | "PAUSED" | "DELETED" | "ARCHIVED";

export interface MetaAccount {
  id: string;
  name: string;
  currency?: string;
  timezone?: string;
  status?: string;
  isBusiness?: boolean;
}

export interface MetaCampaign {
  id: string;
  name: string;
  objective?: string;
  status?: string;
  effectiveStatus?: string;
  /** Meta `daily_budget` — minor unit (cent), dönüşüm yapılmaz. */
  dailyBudgetCents?: number;
  /** Meta `lifetime_budget` — minor unit (cent), dönüşüm yapılmaz. */
  lifetimeBudgetCents?: number;
  startDate?: string;
  stopDate?: string;
}

export interface MetaAdSet {
  id: string;
  campaignId: string;
  name: string;
  status?: string;
  effectiveStatus?: string;
  bidStrategy?: string;
  optimizationGoal?: string;
  billingEvent?: string;
  /** Meta `daily_budget` — minor unit (cent), dönüşüm yapılmaz. */
  dailyBudgetCents?: number;
  /** Meta `lifetime_budget` — minor unit (cent), dönüşüm yapılmaz. */
  lifetimeBudgetCents?: number;
  targeting?: unknown;
}

export interface MetaAd {
  id: string;
  adSetId: string;
  name: string;
  status?: string;
  effectiveStatus?: string;
  creativeId?: string;
  creative?: unknown;
}

/** Reklamın teslimat sorunu (`issues_info[]`). */
export interface MetaAdIssue {
  code: number | null;
  summary: string | null;
  message: string | null;
  level: string | null;
}

/**
 * Ad inceleme durumu (spec 3.5: Meta red gerekçeleri). Reklam alanı `ad_review_feedback`
 * (AdgroupReviewFeedback: `global`, `placement_specific`); kampanya nesnesinde inceleme geri bildirimi yoktur.
 * Kaynak: developers.facebook.com/docs/marketing-api/reference/adgroup (effective_status enum'u) ve
 * /reference/adgroup-review-feedback (2026-09-27 kontrol edildi; bkz. docs/meta-constraints.md).
 */
export interface MetaAdReview {
  id: string;
  name?: string;
  adsetId?: string;
  effectiveStatus?: string;
  configuredStatus?: string;
  /** ad_review_feedback.global: { "key": "description" } — platformlar arası red nedenleri. */
  reviewFeedbackGlobal?: Record<string, string>;
  /** ad_review_feedback.placement_specific: { placement: { "key": "description" } }. */
  reviewFeedbackPlacements?: Record<string, Record<string, string>>;
  /** issues_info: teslimatı etkileyen sorunlar (WITH_ISSUES). */
  issues?: MetaAdIssue[];
}

export interface MetaAdReviewResult {
  review: MetaAdReview | null;
  fetchedAt: string;
}

export type MetaInsightLevel = "account" | "campaign" | "adset" | "ad";

export interface MetaInsightOptions {
  /** Yalnızca account seviyesi sorgular: dönüş satırı ayrıntı düzeyi. */
  level?: "campaign" | "adset" | "ad";
  datePreset?: DatePreset;
  timeRange?: InsightDateRange; // datePreset varsa timeRange kullanılmaz
  /** 1 = günlük satır, "all_days" = toplam. Varsayılan: tüm aralığın toplamı. */
  timeIncrement?: number | "all_days";
  /** Ekstra isteğe bağlı alanlar. */
  extraFields?: string[];
}

export interface InsightDateRange {
  since: string; // YYYY-MM-DD
  until: string; // YYYY-MM-DD
}

export type DatePreset =
  | "today"
  | "yesterday"
  | "last_3d"
  | "last_7d"
  | "last_14d"
  | "last_28d"
  | "last_30d"
  | "last_90d"
  | "this_month"
  | "last_month"
  | "maximum";

export interface InsightQuery {
  level: MetaInsightLevel;
  datePreset?: DatePreset;
  timeRange?: InsightDateRange; // datePreset varsa timeRange kullanılmaz
  /** 1 = günlük satır, "all_days" = toplam. Varsayılan: tüm aralığın toplamı. */
  timeIncrement?: number | "all_days";
  /** Ekstra isteğe bağlı alanlar. */
  extraFields?: string[];
}

export const INSIGHT_DEFAULT_FIELDS = [
  "campaign_id",
  "campaign_name",
  "adset_id",
  "adset_name",
  "ad_id",
  "ad_name",
  "impressions",
  "reach",
  "frequency",
  "clicks",
  "inline_link_clicks",
  "ctr",
  "cpc",
  "cpm",
  "spend",
  "actions",
  "action_values",
  "date_start",
  "date_stop",
] as const;

/** Normalize edilmiş insight satırı (major tutarlar). */
export interface MetaInsightRow {
  dateStart: string;
  dateStop: string;
  campaignId?: string;
  campaignName?: string;
  adsetId?: string;
  adsetName?: string;
  adId?: string;
  adName?: string;
  impressions: number;
  reach?: number;
  frequency?: number;
  clicks: number;
  linkClicks: number;
  ctr?: number; // oran (0-1)
  cpc?: number; // major
  cpm?: number; // major
  spendMajor: number;
  purchases: number;
  purchaseValueMajor: number;
  leads: number;
  addsToCart: number;
  initiatesCheckout: number;
}

export interface MetaApiErrorShape {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  error_user_title?: string;
  error_user_msg?: string;
  fbtrace_id?: string;
}

export interface MetaPagedResponse<T> {
  data: T[];
  paging?: {
    cursors?: { before?: string; after?: string };
    next?: string;
  };
}

// ---------------------------------------------------------------------------
// Girdi/çıktı imzaları
// ---------------------------------------------------------------------------

export interface UpdateBudgetInput {
  entityType: "campaign" | "adset";
  entityId: string;
  dailyBudgetCents: number;
}

export interface SetStatusInput {
  entityType: "campaign" | "adset" | "ad";
  entityId: string;
  status: "ACTIVE" | "PAUSED";
}

/** Planlayıcı hedefleri (ürün içi) — Meta ODAX objective'lerine `toMetaObjective` ile eşlenir. */
export type PlannerObjective = "MAX_ROAS" | "MAX_CONVERSIONS" | "MAX_IMPRESSIONS";

/** Meta ODAX (outcome-driven) kampanya objective'leri (v26). */
export type MetaOutcomeObjective =
  | "OUTCOME_SALES"
  | "OUTCOME_LEADS"
  | "OUTCOME_AWARENESS"
  | "OUTCOME_TRAFFIC"
  | "OUTCOME_ENGAGEMENT"
  | "OUTCOME_APP_PROMOTION";

export interface CreateCampaignInput {
  accountId: string; // act_... olmadan, ham hesap id
  name: string;
  /** `MAX_ROAS | MAX_CONVERSIONS | MAX_IMPRESSIONS` (planlayıcı) veya doğrudan `OUTCOME_*`. */
  objective: PlannerObjective | MetaOutcomeObjective | string;
  /** Minor unit (cent). Yalnızca CBO'da (`budgetStrategy` ABO değilse) `daily_budget` olarak gönderilir. */
  dailyBudgetCents?: number;
  /** CBO: bütçe kampanya seviyesinde; ABO: bütçe ad set seviyesinde, kampanyaya `daily_budget` gönderilmez. */
  budgetStrategy?: "CBO" | "ABO";
  /** Yayın zinciri kuralı: yeni kampanyalar her zaman önce PAUSED oluşturulur; başka değer kabul edilmez. */
  status?: "PAUSED";
}

export interface MetaCreateCampaignResult {
  success: boolean;
  campaignId: string;
  metaResponse?: unknown;
}

export interface UpdateOrigin {
  source: "MANUAL" | "AGENT";
  requestId?: string;
  decisionId?: string;
}

export interface MetaUpdateResult {
  success: boolean;
  entityType: string;
  entityId: string;
  metaResponse?: unknown;
}

/** Graph `POST` ile oluşturulan nesne (ad set, kreatif, reklam, lead formu). */
export interface MetaCreatedObject {
  id: string;
  metaResponse?: unknown;
}

/** Reklam görseli yükleme girdisi: base64 içerik (Meta `bytes` parametresi). */
export interface AdImageUpload {
  bytesBase64: string;
  /** Yalnızca kayıt/iz için; Meta'ya gönderilmez. */
  filename: string;
}

/** Reklam hesabı görsel kütüphanesindeki görsel: kreatiflerde `image_hash` olarak kullanılır. */
export interface MetaAdImage {
  hash: string;
  url?: string;
}

/** `search?type=adlocale` sonucu: `targeting.locales` için sayısal anahtar. */
export interface MetaAdLocale {
  key: number;
  name: string;
}

export interface MetaClientOptions {
  /** Graph API sürümü; META_API_VERSION env'den okunur. Koda sabit yazılmaz. */
  version?: string;
  /** Gerçek isteklerde kullanılacak HTTP taşıyıcı (test için enjekte edilebilir). */
  fetchFn?: typeof fetch;
  /**
   * Uygulama gizli anahtarı: verilirse her çağrıya `appsecret_proof` eklenir ("Require App Secret").
   * `createMetaClient` bunu `META_APP_SECRET`'tan geçirir; doğrudan kurulumda verilmezse kanıt gönderilmez.
   */
  appSecret?: string;
}

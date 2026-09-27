import type { MetaAdIssue, MetaAdReview } from "./types";

/**
 * Reklam düzeyinde Meta inceleme durumu (spec 3.5 — Meta red raporu). SAF modül: Graph yanıtını
 * ayrıştırır ve sınıflandırır; ağ çağrısı ve veritabanı yazımı çağıranda.
 *
 * - Alanlar: `effective_status` (ACTIVE, PAUSED, DELETED, PENDING_REVIEW, DISAPPROVED, PREAPPROVED,
 *   PENDING_BILLING_INFO, CAMPAIGN_PAUSED, ARCHIVED, ADSET_PAUSED, IN_PROCESS, WITH_ISSUES),
 *   `ad_review_feedback` (`global`, `placement_specific`) ve `issues_info`.
 * - Kampanya nesnesinde inceleme geri bildirimi YOKTUR; durum reklamlardan toplanır.
 * Kaynak: developers.facebook.com/docs/marketing-api/reference/adgroup, /reference/adgroup-review-feedback
 * (2026-09-27 kontrol edildi; bkz. docs/meta-constraints.md).
 */

/** Toplu okuma (`GET /?ids=…`) alan listesi. */
export const AD_REVIEW_FIELDS =
  "id,name,adset_id,effective_status,configured_status,ad_review_feedback,issues_info";

/** Graph çoklu kimlik okumasında (`?ids=`) istek başına kimlik üst sınırı. */
export const AD_REVIEW_BATCH_SIZE = 50;

/** Ürün içi reklam inceleme sınıfı. */
export type AdReviewState = "DISAPPROVED" | "WITH_ISSUES" | "PENDING_REVIEW" | "OK" | "UNKNOWN";

/** Kampanyanın reklamlarından toplanan inceleme durumu (`Campaign.metaReviewStatus`). */
export type CampaignReviewStatus = "DISAPPROVED" | "WITH_ISSUES" | "PENDING_REVIEW" | "NO_ISSUES" | "UNKNOWN";

export function classifyAdReview(effectiveStatus: string | null | undefined): AdReviewState {
  switch ((effectiveStatus ?? "").trim().toUpperCase()) {
    case "":
      return "UNKNOWN";
    case "DISAPPROVED":
      return "DISAPPROVED";
    case "WITH_ISSUES":
      return "WITH_ISSUES";
    case "PENDING_REVIEW":
    case "IN_PROCESS":
      return "PENDING_REVIEW";
    default:
      // ACTIVE, PAUSED, CAMPAIGN_PAUSED, ADSET_PAUSED, PREAPPROVED, PENDING_BILLING_INFO, ARCHIVED, DELETED:
      // inceleme engeli yok (ödeme bilgisi gibi hesap sorunları inceleme durumu değildir).
      return "OK";
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringMap(v: unknown): Record<string, string> {
  if (!isRecord(v)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(v).slice(0, 20)) {
    if (value === null || value === undefined) continue;
    out[key.slice(0, 100)] = String(value).slice(0, 500);
  }
  return out;
}

function placementMap(v: unknown): Record<string, Record<string, string>> {
  if (!isRecord(v)) return {};
  const out: Record<string, Record<string, string>> = {};
  for (const [placement, reasons] of Object.entries(v).slice(0, 10)) {
    const map = stringMap(reasons);
    if (Object.keys(map).length > 0) out[placement.slice(0, 60)] = map;
  }
  return out;
}

function optionalString(v: unknown, max = 500): string | null {
  if (typeof v === "string" && v.trim()) return v.trim().slice(0, max);
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function optionalNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function parseIssues(v: unknown): MetaAdIssue[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter(isRecord)
    .slice(0, 5)
    .map((row) => ({
      code: optionalNumber(row.error_code),
      summary: optionalString(row.error_summary, 200),
      message: optionalString(row.error_message),
      level: optionalString(row.level, 40),
    }));
}

/** Tek reklamın Graph yanıtını ayrıştırır (`ad_review_feedback`; eski `review_feedback` adı da okunur). */
export function parseAdReview(raw: unknown, fallbackId: string): MetaAdReview {
  const obj = isRecord(raw) ? raw : {};
  const feedback = isRecord(obj.ad_review_feedback)
    ? obj.ad_review_feedback
    : isRecord(obj.review_feedback)
      ? obj.review_feedback
      : {};
  const issues = parseIssues(obj.issues_info);
  const name = optionalString(obj.name, 400);
  const adsetId = optionalString(obj.adset_id, 64);
  const effectiveStatus = optionalString(obj.effective_status, 40);
  const configuredStatus = optionalString(obj.configured_status, 40);
  return {
    id: optionalString(obj.id, 64) ?? fallbackId,
    ...(name ? { name } : {}),
    ...(adsetId ? { adsetId } : {}),
    ...(effectiveStatus ? { effectiveStatus } : {}),
    ...(configuredStatus ? { configuredStatus } : {}),
    reviewFeedbackGlobal: stringMap(feedback.global),
    reviewFeedbackPlacements: placementMap(feedback.placement_specific),
    ...(issues.length > 0 ? { issues } : {}),
  };
}

/**
 * Çoklu kimlik yanıtı (`{ "<id>": {...}, … }`) → istenen sırayla inceleme listesi. Yanıtta olmayan kimlik
 * (silinmiş/erişilemeyen reklam) atlanır.
 */
export function parseAdReviewBatch(body: unknown, ids: string[]): MetaAdReview[] {
  if (!isRecord(body)) return [];
  const out: MetaAdReview[] = [];
  for (const id of ids) {
    const row = body[id];
    if (isRecord(row)) out.push(parseAdReview(row, id));
  }
  return out;
}

/** İnsan okunur gerekçeler: genel red nedenleri, yerleşim bazlı nedenler ve teslimat sorunları. */
export function adReviewReasons(review: MetaAdReview): string[] {
  const reasons: string[] = [];
  for (const [key, text] of Object.entries(review.reviewFeedbackGlobal ?? {})) reasons.push(text || key);
  for (const [placement, map] of Object.entries(review.reviewFeedbackPlacements ?? {}))
    for (const [key, text] of Object.entries(map)) reasons.push(`${placement}: ${text || key}`);
  for (const issue of review.issues ?? []) {
    const text = issue.summary ?? issue.message;
    if (text) reasons.push(text);
  }
  return Array.from(new Set(reasons)).slice(0, 10);
}

export interface AdReviewSyncItem {
  metaAdId: string;
  effectiveStatus: string | null;
  configuredStatus: string | null;
  state: AdReviewState;
  /** Kalıcı yazılan geri bildirim; sorun yoksa null. */
  feedback: {
    global: Record<string, string>;
    placements: Record<string, Record<string, string>>;
    issues: MetaAdIssue[];
  } | null;
  reasons: string[];
}

export interface AdReviewSummary {
  status: CampaignReviewStatus;
  total: number;
  disapproved: number;
  withIssues: number;
  pending: number;
}

/** Reklam incelemelerini kampanya durumuna toplar: DISAPPROVED > WITH_ISSUES > PENDING_REVIEW > NO_ISSUES. */
export function summarizeAdReviews(states: AdReviewState[]): AdReviewSummary {
  const count = (state: AdReviewState) => states.filter((s) => s === state).length;
  const disapproved = count("DISAPPROVED");
  const withIssues = count("WITH_ISSUES");
  const pending = count("PENDING_REVIEW");
  const ok = count("OK");
  const status: CampaignReviewStatus =
    disapproved > 0
      ? "DISAPPROVED"
      : withIssues > 0
        ? "WITH_ISSUES"
        : pending > 0
          ? "PENDING_REVIEW"
          : ok > 0
            ? "NO_ISSUES"
            : "UNKNOWN";
  return { status, total: states.length, disapproved, withIssues, pending };
}

/** Graph incelemeleri → veritabanına yazılacak kalemler + kampanya özeti. */
export function buildAdReviewSync(reviews: MetaAdReview[]): { items: AdReviewSyncItem[]; summary: AdReviewSummary } {
  const items = reviews.map((review): AdReviewSyncItem => {
    const state = classifyAdReview(review.effectiveStatus);
    const global = review.reviewFeedbackGlobal ?? {};
    const placements = review.reviewFeedbackPlacements ?? {};
    const issues = review.issues ?? [];
    const hasFeedback = Object.keys(global).length > 0 || Object.keys(placements).length > 0 || issues.length > 0;
    return {
      metaAdId: review.id,
      effectiveStatus: review.effectiveStatus ?? null,
      configuredStatus: review.configuredStatus ?? null,
      state,
      feedback: hasFeedback || state === "DISAPPROVED" || state === "WITH_ISSUES" ? { global, placements, issues } : null,
      reasons: adReviewReasons(review),
    };
  });
  return { items, summary: summarizeAdReviews(items.map((i) => i.state)) };
}

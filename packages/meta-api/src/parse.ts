import type { MetaInsightRow } from "./types";

function asNumber(v: unknown, fallback = 0): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : fallback;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

/** actions/action_values dizisinden belirli action_type değerini okur. */
export function actionValue(
  items: unknown,
  type: string,
  key = "value",
): number {
  if (!Array.isArray(items)) return 0;
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (rec.action_type === type) {
      return asNumber(rec[key]);
    }
  }
  return 0;
}

/**
 * Meta `ctr` alanını oran (0-1) olarak normalize eder.
 * Meta `ctr` field'ı kesir döndürür (örn. "0.0233"); bazı eski sürümler
 * yüzde döndürür. Kesinleştirme: docs/meta-constraints.md (2026-09-16).
 */
export function normalizeCtr(raw: unknown): number | undefined {
  const v = asNumber(raw, -1);
  if (v < 0) return undefined;
  return v > 1 ? v / 100 : v;
}

export interface RawInsightRow extends Record<string, unknown> {}

/** Ham Graph insight satırını normalize eder. */
export function normalizeInsightRow(raw: RawInsightRow): MetaInsightRow {
  const actions = raw.actions;
  const actionValues = raw.action_values;
  const purchases =
    actionValue(actions, "purchase") ||
    actionValue(actions, "omni_purchase") ||
    0;
  const purchaseValue = actionValue(actionValues, "purchase", "value");
  const leads =
    actionValue(actions, "lead") ||
    actionValue(actions, "leadgen") ||
    0;
  const addsToCart = actionValue(actions, "add_to_cart");
  const initiatesCheckout = actionValue(actions, "initiate_checkout");
  return {
    dateStart: String(raw.date_start ?? ""),
    dateStop: String(raw.date_stop ?? ""),
    campaignId:
      raw.campaign_id !== undefined ? String(raw.campaign_id) : undefined,
    campaignName:
      raw.campaign_name !== undefined ? String(raw.campaign_name) : undefined,
    adsetId: raw.adset_id !== undefined ? String(raw.adset_id) : undefined,
    adsetName:
      raw.adset_name !== undefined ? String(raw.adset_name) : undefined,
    adId: raw.ad_id !== undefined ? String(raw.ad_id) : undefined,
    adName: raw.ad_name !== undefined ? String(raw.ad_name) : undefined,
    impressions: asNumber(raw.impressions),
    reach: raw.reach !== undefined ? asNumber(raw.reach) : undefined,
    frequency:
      raw.frequency !== undefined ? asNumber(raw.frequency) : undefined,
    clicks: asNumber(raw.clicks),
    linkClicks: asNumber(raw.inline_link_clicks),
    ctr: normalizeCtr(raw.ctr),
    cpc: raw.cpc !== undefined ? asNumber(raw.cpc) : undefined,
    cpm: raw.cpm !== undefined ? asNumber(raw.cpm) : undefined,
    spendMajor: asNumber(raw.spend),
    purchases,
    purchaseValueMajor: purchaseValue,
    leads,
    addsToCart,
    initiatesCheckout,
  };
}

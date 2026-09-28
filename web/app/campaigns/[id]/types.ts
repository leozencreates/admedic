import type { CampaignData } from "../../_lib/campaign-ui";

/** Performans göstergeleri (minor unit; reklam düzeyindeki anlık görüntüler kampanyaya toplanmış). */
export interface Metrics {
  spend: number;
  impressions: number;
  clicks: number;
  leads: number;
  purchases: number;
  conversionValue: number;
}

export interface AdSetRow {
  id: string;
  name: string;
  status: string;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  metaAdSetId: string | null;
  targeting: unknown;
  ads: number;
  metrics30: Metrics;
}

export interface DecisionRow {
  id: string;
  targetType: string;
  targetId: string;
  targetName: string | null;
  action: string;
  approval: string;
  reason: string | null;
  budgetBefore: number | null;
  budgetAfter: number | null;
  changePct: number | null;
  createdAt: string;
  appliedAt: string | null;
}

export interface BudgetChangeRow {
  id: string;
  targetType: string;
  targetId: string;
  targetName: string | null;
  fromCents: number | null;
  toCents: number | null;
  status: string;
  createdAt: string;
  appliedAt: string | null;
}

/** `GET /api/campaigns/:id` yanıtı. */
export interface CampaignDetail {
  campaign: CampaignData;
  adSets: AdSetRow[];
  metrics: { days7: Metrics; days30: Metrics };
  daily: (Metrics & { date: string })[];
  decisions: DecisionRow[];
  budgetChanges: BudgetChangeRow[];
}

/** Lead başı maliyet (minor); lead yoksa null. */
export const cpl = (m: Metrics) => (m.leads > 0 ? Math.round(m.spend / m.leads) : null);
/** Tıklama oranı (0–1); gösterim yoksa null. */
export const ctr = (m: Metrics) => (m.impressions > 0 ? m.clicks / m.impressions : null);
/** Reklam getirisi (dönüşüm değeri / harcama); harcama yoksa null. */
export const roas = (m: Metrics) => (m.spend > 0 ? m.conversionValue / m.spend : null);

export type TabKey = "overview" | "content" | "publish" | "performance" | "decisions";

/** Süren işlem (tıklanan düğme "…iliyor" metnini gösterir). */
export type CampaignAction = "submit" | "approve" | "reject" | "publish" | "activate" | "pause" | "archive" | "review" | "image" | "content";

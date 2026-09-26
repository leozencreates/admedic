/** Öneri türleri: DB `RecommendationType` enum'u + `action.type` içinde taşınan CONTINUE. */
export const RECOMMENDATION_KIND_LABEL: Record<string, string> = {
  BUDGET_REALLOCATION: "Bütçe yeniden dağıtımı",
  BUDGET_INCREASE: "Bütçe artışı",
  BUDGET_DECREASE: "Bütçe azaltma",
  EXPERIMENT_END: "Deney sonu değerlendirmesi",
  WINNER_PROMOTION: "Kazanan varyantı yayına al",
  CONTINUE: "Deneye devam (sonuç belirsiz)",
};

export const RECOMMENDATION_STATUS_LABEL: Record<string, string> = {
  DRAFT: "Taslak",
  PENDING: "Onay bekliyor",
  APPROVED: "Onaylandı",
  APPLIED: "Uygulandı",
  REJECTED: "Reddedildi",
  EXPIRED: "Süresi doldu",
};

/** Otomatik uygulanabilen türler; diğerleri (EXPERIMENT_END, WINNER_PROMOTION, CONTINUE) değerlendirme notudur. */
export const APPLICABLE_RECOMMENDATION_TYPES = ["BUDGET_INCREASE", "BUDGET_REALLOCATION", "BUDGET_DECREASE"] as const;
export type ApplicableRecommendationType = (typeof APPLICABLE_RECOMMENDATION_TYPES)[number];

export function isApplicableRecommendation(kind: string): kind is ApplicableRecommendationType {
  return (APPLICABLE_RECOMMENDATION_TYPES as readonly string[]).includes(kind);
}

/** Gerçek tür: `action.type` (CONTINUE gibi enum dışı türler) yoksa DB türü. */
export function recommendationKind(rec: { type: string; action?: unknown }): string {
  const action = rec.action as { type?: unknown } | null | undefined;
  return typeof action?.type === "string" ? action.type : rec.type;
}

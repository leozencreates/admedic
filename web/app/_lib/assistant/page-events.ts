/**
 * Asistan araçlarının açık sayfalara yayınladığı tarayıcı olayları. Ayrı ve bağımlılıksız bir modüldür: sayfalar
 * dinlemek için araç kaydını (zod, gezinme ağacı) paketlerine almaz.
 */

/**
 * `open_campaign` aynı kampanya sayfası zaten açıkken sekmeyi değiştirir. `router.push` aynı dinamik yolda sayfayı
 * yeniden bağlamaz; sayfa `?tab` değerini yalnızca ilk yüklemede okur. Ayrıntı: `{ campaignId, tab }` (tab yoksa genel bakış).
 */
export const ASSISTANT_CAMPAIGN_TAB_EVENT = "app:assistant-campaign-tab";

export interface AssistantCampaignTabDetail {
  campaignId: string;
  tab?: string;
}

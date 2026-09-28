/** Uyarı türü ve durum etiketleri — `AlertType` / `AlertStatus` enum'larıyla birebir (içerik rehberi, ADR-0016). */
import { alertStatusStyle } from "./labels";

export const ALERT_TYPE_LABEL: Record<string, string> = {
  ROAS_DROP: "Reklam getirisi (ROAS) düştü",
  SPEND_SPIKE: "Harcama beklenmedik biçimde arttı",
  ZERO_PURCHASES: "Tamamlanan tedavi yok",
  ZERO_CONVERSION_VALUE: "Dönüşüm değeri yok",
  HIGH_CPA: "Yüksek lead başı maliyet",
  META_API_ERROR: "Meta hatası",
  META_DISCONNECTED: "Meta bağlantısı koptu",
  PAUSE_APPLIED: "Duraklatma uygulandı",
  WINNER_DETECTED: "Kazanan varyant belirlendi",
  BUDGET_LIMIT_90: "Aylık harcama üst sınırının %90'ı kullanıldı",
  DUPLICATE_CAMPAIGN: "Yinelenen kampanya",
  PIXEL_ERROR: "Meta Pikseli hatası",
  CREATIVE_FATIGUE: "Reklam yorgunluğu",
  BUDGET_MODIFIED_EXTERNAL: "Bütçe Meta'da değiştirildi",
  TOKEN_EXPIRING: "Meta bağlantısının süresi doluyor",
  CONVERSATION_ESCALATED: "Asistan konuşmayı devretti",
  AD_DISAPPROVED: "Meta reklamı reddetti",
};

export const ALERT_STATUS_LABEL: Record<string, string> = {
  OPEN: "Açık",
  ACKED: "Görüldü",
  RESOLVED: "Çözüldü",
};

export function alertTypeLabel(type: string): string {
  return ALERT_TYPE_LABEL[type] ?? "Diğer uyarı";
}

export function alertStatusLabel(status: string): string {
  return alertStatusStyle(status).label;
}

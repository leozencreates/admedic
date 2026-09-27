/** Uyarı türü ve durum etiketleri — `AlertType` / `AlertStatus` enum'larıyla birebir. */
export const ALERT_TYPE_LABEL: Record<string, string> = {
  ROAS_DROP: "ROAS düşüşü",
  SPEND_SPIKE: "Harcama sıçraması",
  ZERO_PURCHASES: "Satın alma yok",
  ZERO_CONVERSION_VALUE: "Dönüşüm değeri yok",
  HIGH_CPA: "Yüksek CPL/CPA",
  META_API_ERROR: "Meta API hatası",
  META_DISCONNECTED: "Meta bağlantısı koptu",
  PAUSE_APPLIED: "Duraklatma uygulandı",
  WINNER_DETECTED: "Kazanan tespit edildi",
  BUDGET_LIMIT_90: "Bütçe limiti %90",
  DUPLICATE_CAMPAIGN: "Yinelenen kampanya",
  PIXEL_ERROR: "Pixel hatası",
  CREATIVE_FATIGUE: "Kreatif yorgunluğu",
  BUDGET_MODIFIED_EXTERNAL: "Bütçe dışarıdan değiştirildi",
  TOKEN_EXPIRING: "Token süresi dolmak üzere",
  CONVERSATION_ESCALATED: "Konuşma koordinatöre devredildi",
  AD_DISAPPROVED: "Meta reklamı reddetti",
};

export const ALERT_STATUS_LABEL: Record<string, string> = {
  OPEN: "Açık",
  ACKED: "Görüldü",
  RESOLVED: "Çözüldü",
};

export function alertTypeLabel(type: string): string {
  return ALERT_TYPE_LABEL[type] ?? type;
}

export function alertStatusLabel(status: string): string {
  return ALERT_STATUS_LABEL[status] ?? status;
}

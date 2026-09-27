/**
 * Meta Business Login için istenen izinler ve eksik izin hesabı (spec 3.1).
 * İzin seti değişirse tek yerden güncellenir; oauth dialog, callback, yenileme
 * ve UI buradan beslenir.
 *
 * - ZORUNLU izinler eksikse bağlantı `missingPermissions` ile işaretlenir (UI'da
 *   uyarı; kampanya/lead işlemleri için gereklidir).
 * - OPSİYONEL izinler (mesajlaşma, Instagram, WhatsApp) eksikse bağlantı kurulur;
 *   UI'da ayrı "opsiyonel eksik" listesi gösterilir.
 */
export const META_REQUIRED_SCOPES = [
  "ads_management",
  "ads_read",
  "business_management",
  "pages_show_list",
  "leads_retrieval",
] as const;

export const META_OPTIONAL_SCOPES = [
  "pages_manage_metadata",
  /** Instant Form (leadgen_forms) oluşturma ve sayfa token'ıyla lead okuma (lead ads App Review). */
  "pages_manage_ads",
  "pages_messaging",
  "instagram_basic",
  "instagram_manage_messages",
  "whatsapp_business_messaging",
  "whatsapp_business_management",
] as const;

/** OAuth dialog'unda istenen tam set (zorunlu + opsiyonel). */
export const META_OAUTH_SCOPES = [
  "business_management",
  "ads_management",
  "ads_read",
  "pages_show_list",
  "pages_manage_metadata",
  "pages_manage_ads",
  "pages_messaging",
  "leads_retrieval",
  "instagram_basic",
  "instagram_manage_messages",
  "whatsapp_business_messaging",
  "whatsapp_business_management",
] as const;

export type MetaScope = (typeof META_OAUTH_SCOPES)[number];

/** Zorunlu izinlerden verilmemiş olanlar (bağlantı `missingPermissions`). */
export function requiredScopesMissing(granted: readonly string[]): string[] {
  const grantedSet = new Set(granted);
  return META_REQUIRED_SCOPES.filter((scope) => !grantedSet.has(scope));
}

/** Opsiyonel izinlerden verilmemiş olanlar (UI'da ayrı listelenir; bağlantıyı engellemez). */
export function optionalScopesMissing(granted: readonly string[]): string[] {
  const grantedSet = new Set(granted);
  return META_OPTIONAL_SCOPES.filter((scope) => !grantedSet.has(scope));
}

export function isRequiredScope(scope: string): boolean {
  return (META_REQUIRED_SCOPES as readonly string[]).includes(scope);
}

/** Eksik izinleri kullanıcıya gösterilebilir kısa adlara çevirir. */
export function scopeLabel(scope: string): string {
  switch (scope) {
    case "business_management":
      return "Business Manager yönetimi";
    case "ads_management":
      return "Reklam yönetimi";
    case "ads_read":
      return "Reklam okuma";
    case "pages_manage_metadata":
      return "Sayfa meta verisi yönetimi";
    case "pages_show_list":
      return "Sayfa listesini görüntüleme";
    case "pages_messaging":
      return "Sayfa mesajlaşması (Messenger)";
    case "leads_retrieval":
      return "Lead formu verilerini okuma";
    case "instagram_basic":
      return "Instagram hesabı (temel)";
    case "instagram_manage_messages":
      return "Instagram mesajlaşması";
    case "whatsapp_business_messaging":
      return "WhatsApp Business mesajlaşması";
    case "whatsapp_business_management":
      return "WhatsApp Business yönetimi";
    default:
      return scope;
  }
}

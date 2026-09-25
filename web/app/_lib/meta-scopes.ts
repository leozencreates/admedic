/**
 * Meta Business Login için gereken izinler ve eksik izin hesabı (spec 3.1).
 * İzin seti değişirse tek yerden güncellenir; oauth dialog, callback ve UI
 * buradan beslenir.
 */
export const META_REQUIRED_SCOPES = [
  "business_management",
  "ads_management",
  "ads_read",
  "pages_manage_metadata",
  "pages_show_list",
] as const;

export function requiredScopesMissing(granted: string[]): string[] {
  const grantedSet = new Set(granted);
  return META_REQUIRED_SCOPES.filter((scope) => !grantedSet.has(scope));
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
    default:
      return scope;
  }
}
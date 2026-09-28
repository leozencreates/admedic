/** Sunucuya ulaşılamadığında ya da yanıt JSON olmadığında gösterilen metin (ağ hatası, HTML hata sayfası). */
export const UNREACHABLE_MESSAGE = "Sunucuya ulaşılamadı. Bağlantınızı kontrol edip tekrar deneyin.";
/** Sunucu hata metni göndermediğinde. */
const FALLBACK_ERROR = "İşlem tamamlanamadı. Birkaç dakika sonra tekrar deneyin.";

export async function api<T>(
  url: string,
  method = "GET",
  data?: unknown,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers:
        data === undefined ? undefined : { "Content-Type": "application/json" },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  } catch {
    throw new Error(UNREACHABLE_MESSAGE);
  }
  let result: { error?: unknown };
  try {
    result = await response.json();
  } catch {
    // "Unexpected token '<'…" gibi ayrıştırma hataları kullanıcıya gösterilmez.
    throw new Error(UNREACHABLE_MESSAGE);
  }
  if (!response.ok)
    throw new Error(typeof result?.error === "string" && result.error ? result.error : FALLBACK_ERROR);
  return result as T;
}

/**
 * Varsayılan reklam hesabının para birimi (ISO 4217); tutarlar bu para birimiyle gösterilir.
 * Hesap yoksa ya da okunamazsa EUR (ADR-0011). Hata fırlatmaz.
 */
export async function defaultAccountCurrency(): Promise<string> {
  try {
    const { accounts } = await api<{ accounts?: Array<{ currency?: string | null; isDefault?: boolean }> }>(
      "/api/platforms/accounts",
    );
    const account = accounts?.find((a) => a.isDefault) ?? accounts?.[0];
    return account?.currency || "EUR";
  } catch {
    return "EUR";
  }
}

/**
 * Eski durum sözlüğü. Yeni kod `labels.ts`'teki `studioStatusStyle` / `experimentStatusStyle`
 * işlevlerini kullanır (etiket + renk tek kaynaktan).
 */
export const labels: Record<string, string> = {
  DRAFT: "Taslak",
  IN_REVIEW: "Onay bekliyor",
  APPROVED: "Onaylandı",
  REJECTED: "Düzeltme istendi",
  RUNNING: "Veri toplanıyor",
  COMPLETED: "Tamamlandı",
};

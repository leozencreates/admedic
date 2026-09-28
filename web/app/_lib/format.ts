/**
 * Tek biçim kaynağı (içerik rehberi, ADR-0016): tutarlar tr-TR, tarihler Europe/Istanbul.
 * - Toplam tutar ondalıksız ("€1.234"), birim maliyet 2 ondalıklı ("€3,18").
 * - Yüzde "%18", oran "29,27×".
 * - Tarih "27 Eyl 2026, 20:57"; listelerde göreli "5 dk önce".
 * Saat dilimi açıkça verildiği için sunucu (UTC) ve tarayıcı aynı metni üretir (hydration uyumu).
 */
const LOCALE = "tr-TR";
export const DISPLAY_TIME_ZONE = "Europe/Istanbul";

function currencyCode(currency: string | null | undefined): string {
  return /^[A-Za-z]{3}$/.test(currency ?? "") ? (currency as string).toUpperCase() : "EUR";
}

/**
 * `cents` minor unit (ADR-0011); `currency` ISO 4217 (reklam hesabından, yoksa EUR).
 * `precise: true` birim maliyetler (CPL, CPC, CPM, günlük test bütçesi) içindir: 2 ondalık.
 */
export function formatMoney(
  cents: number | null | undefined,
  currency: string | null = "EUR",
  options: { precise?: boolean } = {},
): string {
  if (cents == null || !Number.isFinite(cents)) return "—";
  const code = currencyCode(currency);
  const digits = options.precise ? 2 : 0;
  try {
    return new Intl.NumberFormat(LOCALE, {
      style: "currency",
      currency: code,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(cents / 100);
  } catch {
    // Bilinmeyen para birimi kodu: biçimlendirme çökmesin, kod metin olarak eklensin.
    return `${formatDecimal(cents / 100, digits)} ${code}`;
  }
}

/** Ana birimde (ör. avro) tutulan değerler için; minor unit kullanan alanlar `formatMoney` kullanır. */
export function formatMoneyUnits(
  amount: number | null | undefined,
  currency: string | null = "EUR",
  options: { precise?: boolean } = {},
): string {
  if (amount == null || !Number.isFinite(amount)) return "—";
  return formatMoney(Math.round(amount * 100), currency, options);
}

export function formatNumber(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(LOCALE).format(value);
}

/** Sabit ondalıklı sayı: 29.2667 → "29,27". */
export function formatDecimal(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(LOCALE, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

/**
 * Yüzde birimindeki değer (18 = %18) → "%18", "%18,3", "-%5".
 * `digits` en fazla ondalık; sondaki sıfırlar yazılmaz.
 */
export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(LOCALE, {
    style: "percent",
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  }).format(value / 100);
}

/** 0–1 aralığındaki oran (0.183) → "%18,3". */
export function formatRatio(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return formatPercent(value * 100, digits);
}

/** Reklam getirisi (ROAS) gibi katsayılar: 29.2667 → "29,27×". */
export function formatRoas(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${formatDecimal(value, 2)}×`;
}

function toDate(value: Date | string | number): Date {
  return value instanceof Date ? value : new Date(value);
}

function validDate(value: Date | string | number | null | undefined): Date | null {
  if (value == null || value === "") return null;
  const d = toDate(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parts(d: Date, options: Intl.DateTimeFormatOptions): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat(LOCALE, { ...options, timeZone: DISPLAY_TIME_ZONE }).formatToParts(d)) {
    if (part.type !== "literal") out[part.type] = part.value;
  }
  return out;
}

/** "27 Eyl 2026, 20:57" (Europe/Istanbul). */
export function formatDate(value: Date | string | number | null | undefined): string {
  const d = validDate(value);
  if (!d) return "—";
  const p = parts(d, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return `${p.day} ${p.month} ${p.year}, ${p.hour}:${p.minute}`;
}

/** "27 Eyl 2026" (Europe/Istanbul). */
export function formatDay(value: Date | string | number | null | undefined): string {
  const d = validDate(value);
  if (!d) return "—";
  const p = parts(d, { day: "numeric", month: "short", year: "numeric" });
  return `${p.day} ${p.month} ${p.year}`;
}

/** Grafik ekseni ve kısa listeler: "29 Eyl". */
export function formatShortDay(value: Date | string | number | null | undefined): string {
  const d = validDate(value);
  if (!d) return "—";
  const p = parts(d, { day: "numeric", month: "short" });
  return `${p.day} ${p.month}`;
}

/**
 * Süre (bekleme, kalan süre, ilk yanıt; tek biçim): 45 sn → "1 dk'dan az", "12 dk", "3 sa 5 dk", "5 sa", "2 gün".
 * Aşağı yuvarlar (bekleme süresi abartılmaz).
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "1 dk'dan az";
  if (minutes < 60) return `${minutes} dk`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} sa ${minutes % 60} dk` : `${hours} sa`;
  return `${Math.floor(hours / 24)} gün`;
}

/**
 * Göreli zaman: "az önce", "12 dk önce", "5 sa önce", "2 gün önce"; 7 günden eskiyse tarih.
 * `now` yalnızca testlerde verilir. Sunucuda üretilen HTML'de kullanmayın (istemci saati farklı olabilir).
 */
export function formatRelative(
  value: Date | string | number | null | undefined,
  now: Date = new Date(),
): string {
  const d = validDate(value);
  if (!d) return "—";
  const diff = now.getTime() - d.getTime();
  // Bir dakikadan az ileri (saat farkı) "az önce"dır; daha ileri tarih gün olarak yazılır.
  if (diff > 7 * 86_400_000 || diff < -60_000) return formatDay(d);
  if (diff < 60_000) return "az önce";
  // Göreli zaman kaba kalır ("5 sa önce"); dakika ayrıntısı yalnızca bir saatin altında.
  const hours = Math.floor(diff / 3_600_000);
  if (hours >= 1 && hours < 24) return `${hours} sa önce`;
  return `${formatDuration(diff)} önce`;
}

/**
 * Hesap para birimine göre minor unit çarpanı (ISO 4217 ondalık kuralı).
 * Meta Insights tutarları (spend/cpc/cpm/action_values) major birimde döner;
 * DB'ye minor unit yazılırken (ADR-0011) hesabın para birimi esas alınır.
 * `@admedic/shared` `minorDecimals` yalnızca 2 ondalıklı birimleri tanır; bu yardımcı
 * 3 ondalıklı (KWD, BHD, JOD, OMR, …) ve 0 ondalıklı (JPY, KRW, …) birimleri kapsar.
 */
const THREE_DECIMAL_CURRENCIES = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);
const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF",
]);

export function minorUnitFactor(currency: string | null | undefined): number {
  const code = (currency ?? "").trim().toUpperCase();
  if (THREE_DECIMAL_CURRENCIES.has(code)) return 1000;
  if (ZERO_DECIMAL_CURRENCIES.has(code)) return 1;
  return 100;
}

/** Major tutarı hesabın minor unit'ine çevirir (yuvarlanmış tam sayı). */
export function toMinorUnits(major: number | null | undefined, currency: string | null | undefined): number {
  if (major === null || major === undefined || !Number.isFinite(major)) return 0;
  return Math.round(major * minorUnitFactor(currency));
}

/** Para birimi işlemleri — tüm değerler DB'de menor birim (cents) ile saklanır. */
export function toMinor(major: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(major * factor);
}

export function toMajor(minor: number, decimals = 2): number {
  return Number((minor / 10 ** decimals).toFixed(decimals));
}

const CURRENCY_DECIMALS: Record<string, number> = {
  EUR: 2,
  USD: 2,
  GBP: 2,
  TRY: 2,
  CHF: 2,
  AED: 2,
};

export function minorDecimals(currency: string): number {
  return CURRENCY_DECIMALS[currency.toUpperCase()] ?? 2;
}

export function formatMoney(
  minor: number,
  currency = "EUR",
  locale = "tr-TR",
): string {
  try {
    const major = toMajor(minor, minorDecimals(currency));
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: currency.toUpperCase(),
      currencyDisplay: "narrowSymbol",
    }).format(major);
  } catch {
    return `${toMajor(minor)} ${currency}`;
  }
}

/** Arithmetic ROAS: gelir(büyük)/harcama(büyük) oran. */
export function roas(revenueMinor: number, spendMinor: number): number {
  if (spendMinor <= 0) return 0;
  return Number((revenueMinor / spendMinor).toFixed(4));
}

/** CPA: harcama / purchases */
export function cpa(spendMinor: number, purchases: number): number {
  if (purchases <= 0) return 0;
  return Math.round(spendMinor / purchases);
}

export function percentChange(from: number, to: number): number {
  if (from === 0) return 0;
  return ((to - from) / from) * 100;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function roundPct(value: number): number {
  return Math.round(value * 10) / 10;
}
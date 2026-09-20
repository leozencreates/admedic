const CURRENCY_LOCALE = "tr-TR";

export function formatMoney(cents: number | null | undefined, currency = "EUR"): string {
  if (cents == null) return "—";
  return new Intl.NumberFormat(CURRENCY_LOCALE, {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

export function formatNumber(value: number | null | undefined): string {
  if (value == null) return "—";
  return new Intl.NumberFormat(CURRENCY_LOCALE).format(value);
}

export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value == null) return "—";
  return `${value.toFixed(digits)}%`;
}

export function formatRoas(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(2)}×`;
}

export function formatDate(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  return new Intl.DateTimeFormat(CURRENCY_LOCALE, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(d);
}

export function formatDay(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  return new Intl.DateTimeFormat(CURRENCY_LOCALE, { dateStyle: "medium" }).format(d);
}

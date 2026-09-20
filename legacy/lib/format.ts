export function kurusToTL(kurus: number): string {
  return (kurus / 100).toLocaleString("tr-TR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function formatTL(kurus: number): string {
  return `${kurusToTL(kurus)} ₺`;
}

export function formatRoas(roas: number): string {
  if (!Number.isFinite(roas)) return "-";
  return roas.toFixed(2);
}

export function formatNumber(n: number): string {
  return n.toLocaleString("tr-TR");
}

export function formatDate(d: Date | string | null | undefined): string {
  if (!d) return "-";
  return new Date(d).toLocaleDateString("tr-TR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

export function formatDateTime(d: Date | string | null | undefined): string {
  if (!d) return "-";
  return new Date(d).toLocaleString("tr-TR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export const TEST_STATUS_LABEL: Record<string, string> = {
  RUNNING: "Çalışıyor",
  WINNER_SELECTED: "Kazanan Seçildi",
  STOPPED: "Durduruldu",
};

export const TEST_STATUS_COLOR: Record<string, string> = {
  RUNNING: "bg-emerald-100 text-emerald-800",
  WINNER_SELECTED: "bg-blue-100 text-blue-800",
  STOPPED: "bg-zinc-200 text-zinc-700",
};

export const ACTION_TYPE_LABEL: Record<string, string> = {
  TEST_START: "Test Başlatıldı",
  BUDGET_SHIFT: "Bütçe Kaydırıldı",
  WINNER_SELECTED: "Kazanan Seçildi",
  TEST_STOPPED: "Test Durduruldu",
  NEEDS_MORE_DATA: "Veri Bekleniyor",
  WARNING: "Uyarı",
};

export const SEVERITY_COLOR: Record<string, string> = {
  INFO: "border-emerald-300",
  WARNING: "border-amber-300",
  CRITICAL: "border-red-300",
};
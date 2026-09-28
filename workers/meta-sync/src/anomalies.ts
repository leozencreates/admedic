import { minorUnitFactor } from "./money";

/**
 * Anomali uyarıları (spec 3.10, Faz 3): kampanya bazında son 7 gün ile önceki 7 günün
 * `InsightSnapshot` karşılaştırması. Saf fonksiyon — veritabanına dokunmaz, worker
 * (`scheduler.ts`) satırları verir ve sonucu `Alert` tablosuna dedup'lu yazar.
 *
 * Pencereler, satırlardaki en güncel güne (anchor) göre hizalanır: Meta `last_7d`
 * bugünü içermediği için "bugün"e sabitlemek eksik gün üretirdi.
 */
export interface DailyCampaignRow {
  campaignId: string;
  campaignName?: string | null;
  /** UTC günü (Date veya "YYYY-MM-DD"). */
  date: Date | string;
  /** minor unit (cent/kuruş). */
  spend: number;
  impressions: number;
  clicks: number;
  leads: number;
  /** minor unit (cent/kuruş). */
  conversionValue: number;
  /** Hesap para birimi (mesaj biçimlendirmesi için). */
  currency?: string | null;
}

export type AnomalyType = "ROAS_DROP" | "SPEND_SPIKE" | "HIGH_CPA" | "CREATIVE_FATIGUE";
export type AnomalySeverity = "INFO" | "WARNING" | "CRITICAL";

export interface AnomalyAlert {
  type: AnomalyType;
  severity: AnomalySeverity;
  title: string;
  message: string;
  entityType: "CAMPAIGN";
  entityId: string;
}

export const ANOMALY_THRESHOLDS = {
  windowDays: 7,
  /** ROAS düşüşü oranı (0.3 = %30). */
  roasDropRatio: 0.3,
  /** Günlük harcama / önceki dönem günlük ortalaması. */
  spendSpikeFactor: 2,
  /** CPL / önceki dönem CPL. */
  cplIncreaseFactor: 1.5,
  /** HIGH_CPA için güncel dönemde en az lead sayısı. */
  minLeadsForCpl: 3,
  /** CTR oranı (0.005 = %0,5). */
  fatigueCtr: 0.005,
  fatigueMinImpressions: 1000,
} as const;

interface WindowTotals {
  spend: number;
  impressions: number;
  clicks: number;
  leads: number;
  conversionValue: number;
  /** Penceredeki günler: gün indeksi → harcama. */
  spendByDay: Map<number, number>;
}

interface CampaignWindows {
  campaignId: string;
  campaignName: string;
  currency: string;
  current: WindowTotals;
  previous: WindowTotals;
}

function emptyTotals(): WindowTotals {
  return { spend: 0, impressions: 0, clicks: 0, leads: 0, conversionValue: 0, spendByDay: new Map() };
}

/** UTC gün indeksi (1970'ten itibaren gün sayısı). */
export function utcDayIndex(value: Date | string): number | null {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return Math.floor(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()) / 86_400_000);
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  if (!m) return null;
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000);
}

function dayIndexToIso(day: number): string {
  return new Date(day * 86_400_000).toISOString().slice(0, 10);
}

/** Arayüzle aynı biçim (tr-TR): "€250,00". Bilinmeyen para birimi kodla yazılır. */
function money(minor: number, currency: string): string {
  const factor = minorUnitFactor(currency);
  const digits = factor === 1000 ? 3 : factor === 1 ? 0 : 2;
  try {
    return new Intl.NumberFormat("tr-TR", { style: "currency", currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(minor / factor);
  } catch {
    return `${decimal(minor / factor, digits)} ${currency}`;
  }
}

/** Ondalık sayı, Türkçe biçim ("2,00"). */
function decimal(value: number, digits: number): string {
  return value.toLocaleString("tr-TR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function add(totals: WindowTotals, row: DailyCampaignRow, day: number): void {
  totals.spend += row.spend;
  totals.impressions += row.impressions;
  totals.clicks += row.clicks;
  totals.leads += row.leads;
  totals.conversionValue += row.conversionValue;
  totals.spendByDay.set(day, (totals.spendByDay.get(day) ?? 0) + row.spend);
}

/** Satırları kampanya bazında güncel/önceki 7 gün pencerelerine ayırır. */
export function buildCampaignWindows(
  rows: DailyCampaignRow[],
  options: { anchor?: Date | string; windowDays?: number } = {},
): CampaignWindows[] {
  const windowDays = options.windowDays ?? ANOMALY_THRESHOLDS.windowDays;
  const indexed = rows
    .map((row) => ({ row, day: utcDayIndex(row.date) }))
    .filter((r): r is { row: DailyCampaignRow; day: number } => r.day !== null);
  if (indexed.length === 0) return [];
  const anchor =
    (options.anchor !== undefined ? utcDayIndex(options.anchor) : null) ??
    Math.max(...indexed.map((r) => r.day));
  const currentStart = anchor - windowDays + 1;
  const previousStart = currentStart - windowDays;
  const byCampaign = new Map<string, CampaignWindows>();
  for (const { row, day } of indexed) {
    if (day < previousStart || day > anchor) continue;
    let entry = byCampaign.get(row.campaignId);
    if (!entry) {
      entry = {
        campaignId: row.campaignId,
        campaignName: row.campaignName?.trim() || row.campaignId,
        currency: (row.currency ?? "EUR").toUpperCase(),
        current: emptyTotals(),
        previous: emptyTotals(),
      };
      byCampaign.set(row.campaignId, entry);
    }
    add(day >= currentStart ? entry.current : entry.previous, row, day);
  }
  return [...byCampaign.values()];
}

/** Günlük `InsightSnapshot` satırlarından anomali uyarıları üretir. */
export function detectAnomalies(
  rows: DailyCampaignRow[],
  options: { anchor?: Date | string } = {},
): AnomalyAlert[] {
  const t = ANOMALY_THRESHOLDS;
  const alerts: AnomalyAlert[] = [];
  for (const c of buildCampaignWindows(rows, options)) {
    const { current, previous, currency } = c;

    // ROAS %30+ düşüş → WARNING
    if (current.spend > 0 && previous.spend > 0) {
      const prevRoas = previous.conversionValue / previous.spend;
      const curRoas = current.conversionValue / current.spend;
      if (prevRoas > 0) {
        const drop = (prevRoas - curRoas) / prevRoas;
        if (drop >= t.roasDropRatio) {
          alerts.push({
            type: "ROAS_DROP",
            severity: "WARNING",
            title: `ROAS düşüşü: ${c.campaignName}`,
            message: `Son 7 gün reklam getirisi (ROAS) ${decimal(curRoas, 2)}× (önceki 7 gün ${decimal(prevRoas, 2)}×); %${Math.round(drop * 100)} düşüş.`,
            entityType: "CAMPAIGN",
            entityId: c.campaignId,
          });
        }
      }
    }

    // Günlük harcama önceki dönem ortalamasının 2× üstü → WARNING
    const prevDailyAvg = previous.spend / t.windowDays;
    if (prevDailyAvg > 0 && current.spendByDay.size > 0) {
      const latestDay = Math.max(...current.spendByDay.keys());
      const latestSpend = current.spendByDay.get(latestDay) ?? 0;
      if (latestSpend > prevDailyAvg * t.spendSpikeFactor) {
        alerts.push({
          type: "SPEND_SPIKE",
          severity: "WARNING",
          title: `Harcama sıçraması: ${c.campaignName}`,
          message: `${dayIndexToIso(latestDay)} günü harcama ${money(latestSpend, currency)}; önceki 7 gün ortalaması ${money(Math.round(prevDailyAvg), currency)}/gün (${decimal(latestSpend / prevDailyAvg, 1)}×).`,
          entityType: "CAMPAIGN",
          entityId: c.campaignId,
        });
      }
    }

    // CPL önceki dönemin 1.5× üstü ve en az 3 lead → CRITICAL
    if (current.leads >= t.minLeadsForCpl && previous.leads > 0 && previous.spend > 0) {
      const curCpl = current.spend / current.leads;
      const prevCpl = previous.spend / previous.leads;
      if (curCpl > prevCpl * t.cplIncreaseFactor) {
        alerts.push({
          type: "HIGH_CPA",
          severity: "CRITICAL",
          title: `Yüksek lead başı maliyet: ${c.campaignName}`,
          message: `Son 7 gün lead başı maliyet (CPL) ${money(Math.round(curCpl), currency)} (${current.leads} lead); önceki 7 gün ${money(Math.round(prevCpl), currency)}. Artış %${Math.round((curCpl / prevCpl - 1) * 100)}.`,
          entityType: "CAMPAIGN",
          entityId: c.campaignId,
        });
      }
    }

    // CTR < %0,5 ve en az 1000 gösterim → INFO
    if (current.impressions >= t.fatigueMinImpressions) {
      const ctr = current.clicks / current.impressions;
      if (ctr < t.fatigueCtr) {
        alerts.push({
          type: "CREATIVE_FATIGUE",
          severity: "INFO",
          title: `Reklam yorgunluğu: ${c.campaignName}`,
          message: `Son 7 gün tıklama oranı (CTR) %${decimal(ctr * 100, 2)} (${current.impressions.toLocaleString("tr-TR")} gösterim, ${current.clicks.toLocaleString("tr-TR")} tıklama); reklam görselini yenilemeniz önerilir.`,
          entityType: "CAMPAIGN",
          entityId: c.campaignId,
        });
      }
    }
  }
  return alerts;
}

import { describe, expect, it } from "vitest";

import { buildCampaignWindows, detectAnomalies, utcDayIndex, type DailyCampaignRow } from "./anomalies";
import { minorUnitFactor, toMinorUnits } from "./money";

/** anchor = 2026-09-25; güncel pencere 19–25 Eylül, önceki pencere 12–18 Eylül. */
const ANCHOR = "2026-09-25";
function day(offset: number): string {
  const d = new Date(`${ANCHOR}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}
function series(
  campaignId: string,
  perDay: (offset: number, window: "current" | "previous") => Partial<DailyCampaignRow>,
  extra: Partial<DailyCampaignRow> = {},
): DailyCampaignRow[] {
  const rows: DailyCampaignRow[] = [];
  for (let offset = 0; offset < 14; offset++) {
    const window = offset < 7 ? "current" : "previous";
    rows.push({
      campaignId,
      campaignName: `Kampanya ${campaignId}`,
      date: day(offset),
      spend: 10_000,
      impressions: 5_000,
      clicks: 100,
      leads: 2,
      conversionValue: 40_000,
      currency: "EUR",
      ...extra,
      ...perDay(offset, window),
    });
  }
  return rows;
}

describe("utcDayIndex / pencereler", () => {
  it("Date ve YYYY-MM-DD aynı gün indeksini verir; geçersiz değer null", () => {
    expect(utcDayIndex("2026-09-25")).toBe(utcDayIndex(new Date("2026-09-25T13:45:00Z")));
    expect(utcDayIndex("garbage")).toBeNull();
    expect(utcDayIndex(new Date("nope"))).toBeNull();
  });

  it("pencereler en güncel güne göre hizalanır; 14 günden eski satırlar dışarıda kalır", () => {
    const rows = series("c1", () => ({}));
    rows.push({ campaignId: "c1", date: day(14), spend: 999_999, impressions: 1, clicks: 1, leads: 0, conversionValue: 0 });
    const [c1] = buildCampaignWindows(rows);
    expect(c1.current.spend).toBe(70_000);
    expect(c1.previous.spend).toBe(70_000);
    expect(c1.current.spendByDay.size).toBe(7);
  });
});

describe("detectAnomalies", () => {
  it("sabit performansta uyarı üretmez", () => {
    expect(detectAnomalies(series("c1", () => ({})))).toEqual([]);
  });

  it("ROAS %30+ düştüğünde ROAS_DROP (WARNING) üretir; %30 altı düşüşte üretmez", () => {
    const drop = series("c1", (_o, w) => (w === "current" ? { conversionValue: 20_000 } : {}));
    const alerts = detectAnomalies(drop);
    expect(alerts.map((a) => a.type)).toEqual(["ROAS_DROP"]);
    expect(alerts[0].severity).toBe("WARNING");
    expect(alerts[0].entityType).toBe("CAMPAIGN");
    expect(alerts[0].entityId).toBe("c1");
    expect(alerts[0].message).toContain("2.00×");
    expect(alerts[0].message).toContain("4.00×");

    const mild = series("c2", (_o, w) => (w === "current" ? { conversionValue: 32_000 } : {}));
    expect(detectAnomalies(mild)).toEqual([]);
  });

  it("son günün harcaması önceki ortalamanın 2× üstündeyse SPEND_SPIKE üretir", () => {
    const rows = series("c1", (o) => (o === 0 ? { spend: 25_000 } : {}));
    const alerts = detectAnomalies(rows);
    expect(alerts.map((a) => a.type)).toEqual(["SPEND_SPIKE"]);
    expect(alerts[0].message).toContain("250.00 EUR");
    expect(alerts[0].message).toContain("100.00 EUR/gün");
    expect(alerts[0].message).toContain(ANCHOR);
    // tam 2× sınırda uyarı yok (strict >)
    expect(detectAnomalies(series("c2", (o) => (o === 0 ? { spend: 20_000 } : {})))).toEqual([]);
  });

  it("önceki dönem verisi yoksa harcama sıçraması/ROAS/CPL uyarısı üretmez", () => {
    const rows = series("c1", () => ({ spend: 50_000 })).filter((r) => utcDayIndex(r.date)! > utcDayIndex(day(7))!);
    expect(detectAnomalies(rows).filter((a) => a.type !== "CREATIVE_FATIGUE")).toEqual([]);
  });

  it("CPL 1.5× üstü ve ≥3 lead → HIGH_CPA (CRITICAL); az lead'de üretmez", () => {
    // güncel: 70.000 / 14 lead = 5.000; önceki: 70.000 / 28 lead = 2.500 → 2×
    const rows = series("c1", (_o, w) => (w === "previous" ? { leads: 4 } : { leads: 2 }));
    const alerts = detectAnomalies(rows);
    expect(alerts.map((a) => a.type)).toEqual(["HIGH_CPA"]);
    expect(alerts[0].severity).toBe("CRITICAL");
    expect(alerts[0].message).toContain("50.00 EUR");
    expect(alerts[0].message).toContain("25.00 EUR");
    expect(alerts[0].message).toContain("%100");

    // güncel dönemde toplam 2 lead (< 3) → uyarı yok
    const few = series("c2", (o, w) => (w === "previous" ? { leads: 4 } : { leads: o === 0 ? 2 : 0 }));
    expect(detectAnomalies(few)).toEqual([]);
  });

  it("CTR < %0,5 ve ≥1000 gösterim → CREATIVE_FATIGUE (INFO); az gösterimde üretmez", () => {
    const rows = series("c1", () => ({ impressions: 5_000, clicks: 20 }));
    const alerts = detectAnomalies(rows);
    expect(alerts.map((a) => a.type)).toEqual(["CREATIVE_FATIGUE"]);
    expect(alerts[0].severity).toBe("INFO");
    expect(alerts[0].message).toContain("%0.40");

    const small = series("c2", () => ({ impressions: 100, clicks: 0 }));
    expect(detectAnomalies(small)).toEqual([]);
  });

  it("kampanyaları ayrı değerlendirir ve para birimini mesajda kullanır", () => {
    const rows = [
      ...series("a", (_o, w) => (w === "current" ? { conversionValue: 0 } : {})),
      // b: yalnızca harcama sıçraması (ROAS ve CPL sabit kalacak şekilde ölçeklenmiş)
      ...series("b", (o) => (o === 0 ? { spend: 90_000, conversionValue: 360_000, leads: 18 } : {}), { currency: "KWD" }),
    ];
    const alerts = detectAnomalies(rows);
    expect(alerts.map((a) => [a.type, a.entityId])).toEqual([
      ["ROAS_DROP", "a"],
      ["SPEND_SPIKE", "b"],
    ]);
    expect(alerts[1].message).toContain("90.000 KWD");
  });
});

describe("minorUnitFactor", () => {
  it("ISO 4217 ondalık kuralına göre çarpan döner", () => {
    expect(minorUnitFactor("EUR")).toBe(100);
    expect(minorUnitFactor("try")).toBe(100);
    expect(minorUnitFactor("KWD")).toBe(1000);
    expect(minorUnitFactor("BHD")).toBe(1000);
    expect(minorUnitFactor("JPY")).toBe(1);
    expect(minorUnitFactor("KRW")).toBe(1);
    expect(minorUnitFactor(undefined)).toBe(100);
    expect(toMinorUnits(12.345, "KWD")).toBe(12_345);
    expect(toMinorUnits(12.34, "EUR")).toBe(1_234);
    expect(toMinorUnits(1234.6, "JPY")).toBe(1_235);
    expect(toMinorUnits(undefined, "EUR")).toBe(0);
  });
});

import { describe, expect, it } from "vitest";
import {
  formatDate,
  formatDay,
  formatDuration,
  formatMoney,
  formatNumber,
  formatPercent,
  formatRelative,
  formatRoas,
} from "../app/_lib/format";

/** Tek biçim kaynağı (ADR-0016): tr-TR sayılar, Europe/Istanbul tarihleri. */
describe("format.ts", () => {
  it("para: toplam ondalıksız, birim maliyet iki ondalıklı; bilinmeyen kod çökmez", () => {
    expect(formatMoney(123456, "EUR")).toBe("€1.235");
    expect(formatMoney(123456, "EUR", { precise: true })).toBe("€1.234,56");
    expect(formatMoney(5000, "XYZ")).toMatch(/^XYZ\s50$/);
    expect(formatMoney(null, "EUR")).toBe("—");
  });

  it("sayı, yüzde ve reklam getirisi", () => {
    expect(formatNumber(1234567)).toBe("1.234.567");
    expect(formatPercent(12.345)).toBe("%12,3");
    expect(formatPercent(-52, 0)).toBe("-%52");
    expect(formatRoas(2.5)).toBe("2,50×");
    expect(formatRoas(null)).toBe("—");
  });

  it("tarih İstanbul gününe göre (UTC 21:30 → ertesi gün 00:30)", () => {
    expect(formatDate("2026-09-28T21:30:00Z")).toBe("29 Eyl 2026, 00:30");
    expect(formatDay("2026-09-28T21:30:00Z")).toBe("29 Eyl 2026");
  });

  it("göreli zaman kaba kalır; 7 günden eski ya da gelecekteki tarih gün olarak yazılır", () => {
    const now = new Date("2026-09-29T12:00:00Z");
    expect(formatRelative(new Date("2026-09-29T11:59:30Z"), now)).toBe("az önce");
    expect(formatRelative(new Date("2026-09-29T11:50:00Z"), now)).toBe("10 dk önce");
    expect(formatRelative(new Date("2026-09-29T08:50:00Z"), now)).toBe("3 sa önce");
    expect(formatRelative(new Date("2026-09-27T12:00:00Z"), now)).toBe("2 gün önce");
    expect(formatRelative(new Date("2026-09-10T12:00:00Z"), now)).toBe("10 Eyl 2026");
    expect(formatRelative(new Date("2026-09-30T12:00:00Z"), now)).toBe("30 Eyl 2026");
  });

  it("süre biçimi bekleme ve kalan süre için aynı", () => {
    expect(formatDuration(45_000)).toBe("1 dk'dan az");
    expect(formatDuration(3 * 3600_000 + 5 * 60_000)).toBe("3 sa 5 dk");
    expect(formatDuration(49 * 3600_000)).toBe("2 gün");
  });
});

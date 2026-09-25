import { describe, it, expect } from "vitest";
import { isReportDay, renderReportPdf, reportPeriod } from "./index";

describe("reportPeriod", () => {
  it("returns the week boundaries containing the given date for reportDay=0 (Sunday)", () => {
    const now = new Date("2026-09-22T12:00:00Z"); // Tuesday
    const { start, end } = reportPeriod(now, 0);
    expect(start.getUTCDay()).toBeLessThanOrEqual(7);
    expect(end.getTime() - start.getTime()).toBe(6 * 24 * 3600 * 1000 + (23 * 3600 + 59 * 60 + 59) * 1000 + 999);
    expect(start <= now && now <= end).toBe(true);
  });
  it("shifts the week start to the configured report day", () => {
    const now = new Date("2026-09-22T12:00:00Z"); // Tuesday (getDay=2)
    const { start } = reportPeriod(now, 6); // Saturday
    expect(start.getDay()).toBe(6);
  });
});

describe("isReportDay", () => {
  it("matches the configured weekday", () => {
    expect(isReportDay(new Date("2026-09-20T08:00:00Z"), 0)).toBe(true); // Sunday
    expect(isReportDay(new Date("2026-09-21T08:00:00Z"), 0)).toBe(false); // Monday
  });
});

describe("renderReportPdf", () => {
  it("renders a non-empty PDF buffer from a report", async () => {
    const pdf = await renderReportPdf({
      period: { start: new Date().toISOString(), end: new Date().toISOString() },
      summary: {
        totalSpend: 12345,
        totalImpressions: 10000,
        totalClicks: 120,
        totalPurchases: 4,
        ctr: 0.012,
        cpl: 30.86,
        newLeads: 22,
        qualifiedLeads: 5,
        totalLeads: 30,
      },
      campaigns: [{ id: "c1", name: "Lider Bölgesi", status: "ACTIVE", createdAt: new Date().toISOString() }],
      unreadAlerts: [{ id: "a1", type: "HIGH_CPA", severity: "HIGH", title: "Kampanya CPL yükseldi", createdAt: new Date().toISOString() }],
    });
    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.length).toBeGreaterThan(100);
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
  });
});
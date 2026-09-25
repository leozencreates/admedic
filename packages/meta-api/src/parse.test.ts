import { describe, expect, it } from "vitest";

import { parseMetaError } from "./http";
import { normalizeCtr, normalizeInsightRow } from "./parse";

describe("parseMetaError", () => {
  it("Meta hata şemasını GraphErrorDetail'e çevirir", () => {
    const d = parseMetaError({
      error: {
        code: 100,
        error_subcode: 1487225,
        error_user_msg:
          "Budgets can be changed a maximum of 4 times every hour per ad set.",
        fbtrace_id: "abc123",
      },
    });
    expect(d.code).toBe(100);
    expect(d.subcode).toBe(1487225);
    expect(d.message).toContain("maximum of 4 times");
  });

  it("error_user_msg yoksa message kullanılır", () => {
    const d = parseMetaError({
      error: { code: 1, message: "An unknown error occurred" },
    });
    expect(d.message).toBe("An unknown error occurred");
    expect(d.subcode).toBeUndefined();
  });

  it("boş gövdelerde güvenli mesaj döner", () => {
    expect(parseMetaError(null).message).toBe("Meta API bilinmeyen hata");
  });
});

describe("normalizeInsightRow", () => {
  it("string tutarları sayıya, actions dizilerini satır alanlarına çevirir", () => {
    const row = normalizeInsightRow({
      date_start: "2026-09-15",
      date_stop: "2026-09-15",
      campaign_id: "2384",
      ad_id: "2385",
      impressions: "9612",
      reach: "8000",
      frequency: "1.2",
      clicks: "210",
      inline_link_clicks: "126",
      ctr: "0.02184",
      cpc: "2.31",
      cpm: "11.02",
      spend: "105.94",
      actions: [{ action_type: "purchase", value: "12" }],
      action_values: [{ action_type: "purchase", value: "34800" }],
    });
    expect(row.spendMajor).toBe(105.94);
    expect(row.impressions).toBe(9612);
    expect(row.frequency).toBe(1.2);
    expect(row.ctr).toBeCloseTo(0.02184, 5);
    expect(row.purchases).toBe(12);
    expect(row.purchaseValueMajor).toBe(34800);
    expect(row.campaignId).toBe("2384");
  });

  it("action dizisi eksikse sıfır döner", () => {
    const row = normalizeInsightRow({ impressions: "1000", spend: "10" });
    expect(row.purchases).toBe(0);
    expect(row.purchaseValueMajor).toBe(0);
    expect(row.adId).toBeUndefined();
  });

  it("lead/add_to_cart/initiate_checkout action türlerini ayrıştırır (spec 3.9)", () => {
    const row = normalizeInsightRow({
      impressions: "120",
      spend: "9.5",
      actions: [
        { action_type: "lead", value: "7" },
        { action_type: "add_to_cart", value: "4" },
        { action_type: "initiate_checkout", value: "2" },
        { action_type: "purchase", value: "1" },
      ],
    });
    expect(row.leads).toBe(7);
    expect(row.addsToCart).toBe(4);
    expect(row.initiatesCheckout).toBe(2);
    expect(row.purchases).toBe(1);
  });
});

describe("normalizeCtr", () => {
  it("kesir değeri aynen döner, yüzdeyi 100'e böler", () => {
    expect(normalizeCtr("0.0233")).toBeCloseTo(0.0233, 5);
    expect(normalizeCtr("2.33")).toBeCloseTo(0.0233, 5);
    expect(normalizeCtr("garbage")).toBeUndefined();
  });
});

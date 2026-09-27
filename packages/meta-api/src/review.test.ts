import { describe, expect, it } from "vitest";

import { MockMetaClient } from "./mock";
import {
  adReviewReasons,
  buildAdReviewSync,
  classifyAdReview,
  parseAdReview,
  parseAdReviewBatch,
  summarizeAdReviews,
} from "./review";

describe("reklam inceleme sınıflandırması", () => {
  it("effective_status'ü ürün içi sınıfa eşler", () => {
    expect(classifyAdReview("DISAPPROVED")).toBe("DISAPPROVED");
    expect(classifyAdReview("with_issues")).toBe("WITH_ISSUES");
    expect(classifyAdReview("PENDING_REVIEW")).toBe("PENDING_REVIEW");
    expect(classifyAdReview("IN_PROCESS")).toBe("PENDING_REVIEW");
    for (const ok of ["ACTIVE", "PAUSED", "CAMPAIGN_PAUSED", "ADSET_PAUSED", "PREAPPROVED", "PENDING_BILLING_INFO", "ARCHIVED"])
      expect(classifyAdReview(ok)).toBe("OK");
    expect(classifyAdReview(undefined)).toBe("UNKNOWN");
    expect(classifyAdReview("")).toBe("UNKNOWN");
  });

  it("kampanya durumu önceliği: DISAPPROVED > WITH_ISSUES > PENDING_REVIEW > NO_ISSUES > UNKNOWN", () => {
    expect(summarizeAdReviews(["OK", "PENDING_REVIEW", "DISAPPROVED", "WITH_ISSUES"])).toEqual({
      status: "DISAPPROVED",
      total: 4,
      disapproved: 1,
      withIssues: 1,
      pending: 1,
    });
    expect(summarizeAdReviews(["OK", "WITH_ISSUES"]).status).toBe("WITH_ISSUES");
    expect(summarizeAdReviews(["OK", "PENDING_REVIEW"]).status).toBe("PENDING_REVIEW");
    expect(summarizeAdReviews(["OK", "UNKNOWN"]).status).toBe("NO_ISSUES");
    expect(summarizeAdReviews([]).status).toBe("UNKNOWN");
  });

  it("ad_review_feedback + issues_info ayrıştırılır; eski review_feedback adı da okunur; gerekçeler tekilleşir", () => {
    const review = parseAdReview(
      {
        id: 123,
        effective_status: "DISAPPROVED",
        ad_review_feedback: {
          global: { PERSONAL_HEALTH: "Sağlık iddiası", DUP: "Sağlık iddiası" },
          placement_specific: { facebook: { TEXT: "Metin oranı" }, instagram: {} },
        },
        issues_info: [{ error_code: 1487, error_summary: "Teslimat sorunu", error_message: "Ayrıntı", level: "AD" }],
      },
      "fallback",
    );
    expect(review.id).toBe("123");
    expect(review.reviewFeedbackPlacements).toEqual({ facebook: { TEXT: "Metin oranı" } });
    expect(review.issues).toEqual([{ code: 1487, summary: "Teslimat sorunu", message: "Ayrıntı", level: "AD" }]);
    expect(adReviewReasons(review)).toEqual(["Sağlık iddiası", "facebook: Metin oranı", "Teslimat sorunu"]);
    expect(parseAdReview({ review_feedback: { global: { X: "Eski" } } }, "9").reviewFeedbackGlobal).toEqual({ X: "Eski" });
    expect(parseAdReview(null, "9")).toEqual({ id: "9", reviewFeedbackGlobal: {}, reviewFeedbackPlacements: {} });
  });

  it("çoklu kimlik yanıtı istenen sırayla döner, eksik kimlik atlanır", () => {
    const rows = parseAdReviewBatch({ b: { id: "b", effective_status: "ACTIVE" }, a: { id: "a" } }, ["a", "b", "c"]);
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(parseAdReviewBatch("bozuk", ["a"])).toEqual([]);
  });

  it("buildAdReviewSync sorunlu reklamda geri bildirimi saklar, sorunsuzda null bırakır", () => {
    const { items, summary } = buildAdReviewSync([
      { id: "1", effectiveStatus: "DISAPPROVED", reviewFeedbackGlobal: { A: "Red" }, reviewFeedbackPlacements: {} },
      { id: "2", effectiveStatus: "ACTIVE", reviewFeedbackGlobal: {}, reviewFeedbackPlacements: {} },
    ]);
    expect(items[0]).toMatchObject({ metaAdId: "1", state: "DISAPPROVED", reasons: ["Red"], feedback: { global: { A: "Red" } } });
    expect(items[1]).toMatchObject({ metaAdId: "2", state: "OK", feedback: null, reasons: [] });
    expect(summary).toMatchObject({ status: "DISAPPROVED", total: 2, disapproved: 1 });
  });

  it("mock istemci: adında rejected geçen reklam reddedilmiş, pending geçen incelemede görünür", async () => {
    const client = new MockMetaClient({ version: "v26.0" });
    const creative = JSON.stringify({ creative_id: "cr_1" });
    const rejected = await client.createAd("111", { name: "Kampanya rejected — A", status: "PAUSED", adset_id: "as_1", creative }, "t");
    const pending = await client.createAd("111", { name: "Kampanya pending — A", status: "PAUSED", adset_id: "as_1", creative }, "t");
    const normal = await client.createAd("111", { name: "Kampanya — A", status: "PAUSED", adset_id: "as_1", creative }, "t");
    const reviews = await client.getAdReviews([rejected.id, pending.id, normal.id], "t");
    expect(reviews.map((r) => r.effectiveStatus)).toEqual(["DISAPPROVED", "PENDING_REVIEW", "ACTIVE"]);
  });
});

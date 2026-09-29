import { afterEach, describe, expect, it, vi } from "vitest";
import { errorSummary, logger } from "../app/_lib/log";
import { runAfterResponse } from "../app/_lib/after-response";

vi.mock("next/server", () => ({ after: () => { throw new Error("İstek kapsamı yok"); } }));
afterEach(() => vi.restoreAllMocks());

describe("kişisel veri içermeyen hata kayıtları", () => {
  it("hata metnini, stack'i ve serbest alanları kaydetmez; bilinen hata kodunu korur", () => {
    const error = Object.assign(new TypeError("patient@example.invalid — özel mesaj"), { code: "P2002" });
    expect(errorSummary(error)).toEqual({ name: "TypeError", code: "P2002" });
    expect(errorSummary("patient@example.invalid")).toEqual({ name: "Error" });
    expect(errorSummary(null)).toEqual({ name: "Error" });
    error.name = "patient@example.invalid";
    error.code = "patient@example.invalid";
    expect(errorSummary(error)).toEqual({ name: "Error" });
    expect(errorSummary(Object.assign(new Error("özel mesaj"), { code: 503 }))).toEqual({ name: "Error", code: "503" });
  });

  it("yanıt sonrası iş başarısız olsa da veri sızdırmaz ve asıl yanıtı bozmaz", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    await expect(runAfterResponse("lead-refetch", async () => {
      throw new Error("patient@example.invalid — özel mesaj");
    })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      { job: "lead-refetch", err: { name: "Error" } }, "arka plan işi tamamlanamadı",
    );
  });
});

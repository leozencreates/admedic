import { describe, expect, it } from "vitest";
import { RefError, RefMap } from "../app/_lib/assistant/ref-map";

// Sesli asistan kayıt ref'leri (ADR-0028 §2): ajan gerçek kimlik görmez, yalnızca okuma sonucundaki kısa ref'i kullanır.
describe("RefMap", () => {
  it("türe göre önekli, artan ve kararlı ref üretir", () => {
    const refs = new RefMap();
    expect(refs.ref("campaign", "cmp_fake_1")).toBe("c1");
    expect(refs.ref("campaign", "cmp_fake_2")).toBe("c2");
    expect(refs.ref("lead", "lead_fake_1")).toBe("l1");
    expect(refs.ref("alert", "alert_fake_1")).toBe("a1");
    expect(refs.ref("campaign", "cmp_fake_1")).toBe("c1");
    expect(refs.existingRef("campaign", "cmp_fake_2")).toBe("c2");
    expect(refs.existingRef("campaign", "cmp_unknown")).toBeNull();
    expect(refs.size).toBe(4);
  });

  it("ref'i yalnızca doğru türde çözer", () => {
    const refs = new RefMap();
    const c = refs.ref("campaign", "cmp_fake_1");
    const l = refs.ref("lead", "lead_fake_1");
    expect(refs.resolve(c, "campaign")).toBe("cmp_fake_1");
    expect(refs.resolve(l, "lead")).toBe("lead_fake_1");
    expect(() => refs.resolve(c, "lead")).toThrow(RefError);
    expect(() => refs.resolve(c, "lead")).toThrow(/kampanya kaydına ait; lead referansı gerekiyor/);
  });

  it("uydurma, biçimsiz ya da gerçek kimlik verilirse Türkçe hata fırlatır", () => {
    const refs = new RefMap();
    refs.ref("campaign", "cmp_fake_1");
    expect(() => refs.resolve("c9", "campaign")).toThrow(/bu konuşmada bulunamadı/);
    expect(() => refs.resolve("cmp_fake_1", "campaign")).toThrow(/Geçersiz kampanya referansı/);
    expect(() => refs.resolve("", "campaign")).toThrow(RefError);
    expect(() => refs.resolve(undefined, "campaign")).toThrow(RefError);
    expect(() => refs.resolve({ id: "cmp_fake_1" }, "campaign")).toThrow(RefError);
  });

  it("clear tüm eşlemeleri ve sayaçları sıfırlar", () => {
    const refs = new RefMap();
    refs.ref("campaign", "cmp_fake_1");
    refs.clear();
    expect(refs.size).toBe(0);
    expect(() => refs.resolve("c1", "campaign")).toThrow(RefError);
    expect(refs.ref("campaign", "cmp_fake_9")).toBe("c1");
  });
});

import { describe, expect, it } from "vitest";

import { clamp, cpa, formatMoney, minorDecimals, percentChange, roas, roundPct, toMajor, toMinor } from "./money";

/** Intl çıktısındaki dar/bölünmez boşlukları sadeleştirir; ICU sürümünden bağımsız karşılaştırma için. */
const plain = (s: string) => s.replace(/[  ]/g, " ");

describe("menor/major dönüşümü", () => {
  it("menor birime yuvarlayarak çevirir; kayan nokta hatası sızmaz", () => {
    expect(toMinor(12.34)).toBe(1234);
    expect(toMinor(0.1 + 0.2)).toBe(30);
    expect(toMinor(19.999)).toBe(2000);
    expect(toMinor(5, 0)).toBe(5);
  });

  it("major birime çevirir ve gidiş-dönüş değeri korur", () => {
    expect(toMajor(1234)).toBe(12.34);
    expect(toMajor(-50)).toBe(-0.5);
    expect(toMajor(toMinor(1234.56))).toBe(1234.56);
  });

  it("bilinmeyen ya da küçük harfli para biriminde 2 hane", () => {
    expect(minorDecimals("eur")).toBe(2);
    expect(minorDecimals("XYZ")).toBe(2);
  });
});

describe("formatMoney", () => {
  it("varsayılan olarak Türkçe yerel ayarla avro biçimler", () => {
    expect(plain(formatMoney(123456))).toBe("€1.234,56");
  });

  it("para birimi kodunu büyük harfe çevirir", () => {
    expect(plain(formatMoney(1000, "usd", "en-US"))).toBe("$10.00");
  });

  it("geçersiz para biriminde hata atmaz, düz metne düşer", () => {
    expect(formatMoney(1050, "NOPE!")).toBe("10.5 NOPE!");
  });
});

describe("reklam metrikleri", () => {
  it("ROAS gelir/harcama oranıdır; harcama yoksa 0", () => {
    expect(roas(30000, 10000)).toBe(3);
    expect(roas(10000, 30000)).toBe(0.3333);
    expect(roas(5000, 0)).toBe(0);
    expect(roas(5000, -100)).toBe(0);
  });

  it("CPA menor birimde yuvarlanır; satın alma yoksa 0", () => {
    expect(cpa(10000, 3)).toBe(3333);
    expect(cpa(10000, 0)).toBe(0);
  });

  it("yüzde değişim; başlangıç 0 ise sonsuz yerine 0", () => {
    expect(percentChange(200, 250)).toBe(25);
    expect(percentChange(200, 100)).toBe(-50);
    expect(percentChange(0, 100)).toBe(0);
  });

  it("clamp sınırlar, roundPct tek ondalığa yuvarlar", () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-1, 0, 3)).toBe(0);
    expect(clamp(2, 0, 3)).toBe(2);
    expect(roundPct(12.345)).toBe(12.3);
    expect(roundPct(-7.25)).toBe(-7.2);
  });
});

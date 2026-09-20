import { describe, expect, it } from "vitest";

import { betainc, betaincInv, lnGamma } from "../src/special";

describe("lnGamma", () => {
  it("known values", () => {
    expect(lnGamma(1)).toBeCloseTo(0, 6);
    expect(lnGamma(2)).toBeCloseTo(0, 6);
    expect(lnGamma(3)).toBeCloseTo(Math.log(2), 6);
    expect(lnGamma(5)).toBeCloseTo(Math.log(24), 6);
    // reflection: x=0.5 → ln(√π)
    expect(lnGamma(0.5)).toBeCloseTo(Math.log(Math.sqrt(Math.PI)), 6);
  });
});

describe("betainc (regularized incomplete beta)", () => {
  it("I_x(1,1) = x", () => {
    for (const x of [0.1, 0.3, 0.5, 0.77, 0.99]) {
      expect(betainc(x, 1, 1)).toBeCloseTo(x, 6);
    }
  });

  it("symmetries", () => {
    expect(betainc(0.5, 2, 2)).toBeCloseTo(0.5, 6);
    // değişim: I_x(a,b) + I_(1−x)(b,a) = 1
    expect(betainc(0.3, 2, 5) + betainc(0.7, 5, 2)).toBeCloseTo(1, 6);
  });

  it("edges", () => {
    expect(betainc(0, 2, 5)).toBe(0);
    expect(betainc(1, 2, 5)).toBe(1);
  });

  it("monotonic increasing and invertible", () => {
    const p = betainc(0.4, 3, 6);
    const xBack = betaincInv(p, 3, 6);
    expect(xBack).toBeCloseTo(0.4, 4);
  });

  it("beta quantile median symmetric", () => {
    // Beta(2,2) medyanı 0.5
    expect(betaincInv(0.5, 2, 2)).toBeCloseTo(0.5, 5);
  });
});
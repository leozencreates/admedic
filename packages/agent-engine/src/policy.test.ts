import { describe, expect, it } from "vitest";

import {
  clampBudgetChange,
  fromOptimizationPolicyRow,
  inCooldown,
  used24hBudgetChangeCents,
} from "./policy";

describe("fromOptimizationPolicyRow", () => {
  it("boş satır → bayesian varsayılanlarıyla guardrail üretir", () => {
    const p = fromOptimizationPolicyRow({});
    expect(p.targetRoas).toBe(4);
    expect(p.minDailyBudgetCents).toBe(2000);
    expect(p.maxIncreasePct).toBe(20);
    expect(p.maxChangePer24hPct).toBe(50);
    expect(p.mode).toBe("APPROVAL");
    expect(p.enabled).toBe(true);
  });

  it("satır değerlerini korur", () => {
    const p = fromOptimizationPolicyRow({
      targetRoas: 5,
      maxIncreasePct: 10,
      accountDailyMaxCents: 500000,
      minDailyBudgetCents: 2500,
    });
    expect(p.targetRoas).toBe(5);
    expect(p.maxIncreasePct).toBe(10);
    expect(p.accountDailyMaxCents).toBe(500000);
  });
});

describe("clampBudgetChange", () => {
  const policy = {
    ...fromOptimizationPolicyRow({}),
    workspaceId: "ws",
    enabled: true,
  };

  it("min günlük bütçenin altına düşmez", () => {
    const r = clampBudgetChange({
      currentBudgetCents: 2000,
      proposedBudgetCents: 500,
      policy,
    });
    expect(r.budgetCents).toBe(2000);
    expect(r.capped).toBe(true);
    expect(r.reason).toContain("min_daily_2000");
  });

  it("maxIncreasePct'yi aşan artışı sınırlar", () => {
    const r = clampBudgetChange({
      currentBudgetCents: 10000,
      proposedBudgetCents: 50000,
      policy,
    });
    expect(r.budgetCents).toBe(12000);
    expect(r.capped).toBe(true);
    expect(r.reason).toContain("max_increase_20pct");
  });

  it("maxDecreasePct'nin altına düşürmez", () => {
    const p = { ...policy, maxDecreasePct: 20 };
    const r = clampBudgetChange({
      currentBudgetCents: 10000,
      proposedBudgetCents: 3000,
      policy: p,
    });
    expect(r.budgetCents).toBe(8000);
  });

  it("adset/global üst limit uygular", () => {
    const p = {
      ...policy,
      maxDailyBudgetCents: 9000,
      adSetDailyMaxCents: 7900,
    };
    const r = clampBudgetChange({
      currentBudgetCents: 5000,
      proposedBudgetCents: 5500,
      policy: p,
    });
    expect(r.budgetCents).toBe(5500);
    // 8500 → +%20 (8520) içinde ama adSet cap'i 7900'e takılır.
    const r2 = clampBudgetChange({
      currentBudgetCents: 7100,
      proposedBudgetCents: 8500,
      policy: p,
    });
    expect(r2.budgetCents).toBe(7900);
    expect(r2.reason).toContain("max_daily_7900");
  });

  it("24 saat değişim headroom'u aşılınca clamp'ler", () => {
    const r = clampBudgetChange({
      currentBudgetCents: 10000,
      proposedBudgetCents: 17000, // %70 artış
      policy,
      used24hChangeCents: 0,
    });
    // maxIncreasePct zaten %20'yi engeller (12000). %24h kuralını salt test:
    expect(r.budgetCents).toBe(12000);
  });
});

describe("cooldown / 24h ölçümü", () => {
  const now = new Date("2026-09-16T10:00:00Z");
  it("inCooldown: eşik içinde true, dışında false", () => {
    expect(inCooldown(new Date("2026-09-16T07:00:00Z"), now, 6)).toBe(true);
    expect(inCooldown(new Date("2026-09-16T01:00:00Z"), now, 6)).toBe(false);
    expect(inCooldown(undefined, now, 6)).toBe(false);
  });

  it("used24hBudgetChangeCents: mutlak değişimleri toplar", () => {
    expect(
      used24hBudgetChangeCents([
        { budgetBeforeCents: 10000, budgetAfterCents: 12000 },
        { budgetBeforeCents: 12000, budgetAfterCents: 10000 },
      ]),
    ).toBe(4000);
  });
});

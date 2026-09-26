/**
 * Abonelik plan tablosu ve Stripe API sürümü — TEK KAYNAK (spec 3.12).
 *
 * Bu dosya bilinçli olarak bağımlılıksızdır: web panelindeki faturalandırma rotaları
 * (`web/app/api/billing/_lib/stripe.ts`) ve bu paketin Stripe istemcisi aynı tabloyu
 * kullanır. Fiyat kimlikleri (`STRIPE_PRICE_*`) ortamdan gelir; tutarlar minor unit
 * (cent, ADR-0011) olarak tutulur ve yalnızca panelde/taslak faturada gösterim içindir —
 * gerçek tahsilat tutarını Stripe Price belirler.
 */

/** Stripe API sürümü; checkout, webhook ve paket istemcisi aynı değeri kullanır. */
export const STRIPE_API_VERSION = "2026-08-26.dahlia" as const;

export const PLAN_CODES = ["FREE", "STARTER", "PROFESSIONAL", "ENTERPRISE"] as const;
export type PlanCode = (typeof PLAN_CODES)[number];

export type PlanPriceEnvKey = "STRIPE_PRICE_STARTER" | "STRIPE_PRICE_PROFESSIONAL" | "STRIPE_PRICE_ENTERPRISE";

export interface PlanDefinition {
  code: PlanCode;
  /** Panelde gösterilen ad (ürün dili Türkçe). */
  label: string;
  /** Aylık tutar, minor unit (cent). */
  amountCents: number;
  currency: "EUR";
  interval: "month";
  /** Stripe Price kimliğini taşıyan ortam değişkeni; ücretsiz planda yok. */
  priceEnv: PlanPriceEnvKey | null;
}

export const PLAN_TABLE: Record<PlanCode, PlanDefinition> = {
  FREE: { code: "FREE", label: "Ücretsiz", amountCents: 0, currency: "EUR", interval: "month", priceEnv: null },
  STARTER: { code: "STARTER", label: "Starter", amountCents: 2990, currency: "EUR", interval: "month", priceEnv: "STRIPE_PRICE_STARTER" },
  PROFESSIONAL: { code: "PROFESSIONAL", label: "Profesyonel", amountCents: 9990, currency: "EUR", interval: "month", priceEnv: "STRIPE_PRICE_PROFESSIONAL" },
  ENTERPRISE: { code: "ENTERPRISE", label: "Kurumsal", amountCents: 24990, currency: "EUR", interval: "month", priceEnv: "STRIPE_PRICE_ENTERPRISE" },
};

export function isPlanCode(value: unknown): value is PlanCode {
  return typeof value === "string" && (PLAN_CODES as readonly string[]).includes(value);
}

/** Ücretli plan mı (Stripe Checkout gerektirir)? */
export function isPaidPlan(plan: PlanCode): boolean {
  return PLAN_TABLE[plan].amountCents > 0;
}

/** Ortamdan planın Stripe Price kimliği; ücretsiz planda veya tanımsızsa `undefined`. */
export function planPriceId(plan: PlanCode, env: Partial<Record<PlanPriceEnvKey, string | undefined>>): string | undefined {
  const key = PLAN_TABLE[plan].priceEnv;
  if (!key) return undefined;
  const value = env[key]?.trim();
  return value ? value : undefined;
}

/** Panel için serileştirilebilir plan listesi. */
export function listPlans(): Array<Pick<PlanDefinition, "code" | "label" | "amountCents" | "currency" | "interval">> {
  return PLAN_CODES.map((code) => {
    const p = PLAN_TABLE[code];
    return { code: p.code, label: p.label, amountCents: p.amountCents, currency: p.currency, interval: p.interval };
  });
}

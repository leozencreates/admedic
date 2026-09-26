import Stripe from "stripe";
import { z } from "zod";
import { loadEnv, type AppEnv } from "@admedic/config";
import type { SubscriptionStatus } from "@admedic/database";
import { HttpError } from "../../../_lib/http";
// Plan tablosu ve API sürümü tek kaynaktan gelir (packages/stripe/src/plans.ts, bağımlılıksız).
// `web`, `@admedic/stripe` paketine bağımlı değildir (pnpm bağlantısı yok); paket bağımlılık olarak
// eklendiğinde bu göreli içe aktarma `@admedic/stripe` olur.
import {
  PLAN_CODES,
  PLAN_TABLE,
  STRIPE_API_VERSION,
  isPaidPlan,
  listPlans,
  planPriceId,
  type PlanCode,
} from "../../../../../packages/stripe/src/plans";

export { PLAN_CODES, PLAN_TABLE, STRIPE_API_VERSION, isPaidPlan, listPlans, planPriceId };
export type { PlanCode };

export const PlanSchema = z.enum(PLAN_CODES);

/**
 * Faturalandırma modu. Mock mod yalnızca `STRIPE_SECRET_KEY` yokken VE production değilken açıktır;
 * production'da anahtar yoksa gerçek mod kabul edilir ve Stripe gerektiren işlemler 503 döner.
 */
export function billingMode(env: AppEnv = loadEnv()): { mock: boolean; env: AppEnv } {
  const mock = !env.STRIPE_SECRET_KEY && env.NODE_ENV !== "production";
  return { mock, env };
}

let cached: { key: string; client: Stripe } | null = null;

/** Stripe istemcisi (gerçek mod). Anahtar yoksa 503; API sürümü paket sabitiyle aynıdır. */
export function getStripe(env: AppEnv = loadEnv()): Stripe {
  const key = env.STRIPE_SECRET_KEY;
  if (!key) throw new HttpError(503, "STRIPE_SECRET_KEY ayarlanmadı; Stripe işlemleri kullanılamıyor.");
  if (!cached || cached.key !== key) cached = { key, client: new Stripe(key, { apiVersion: STRIPE_API_VERSION }) };
  return cached.client;
}

/**
 * Stripe abonelik durumu → SubscriptionStatus. Bilinmeyen/ödenmemiş durumlar asla ACTIVE'e düşmez
 * (fail-safe): unpaid/incomplete/past_due/paused → PAST_DUE, canceled → CANCELED,
 * incomplete_expired → EXPIRED, active/trialing → ACTIVE.
 */
export function mapStripeSubscriptionStatus(status: string | null | undefined): SubscriptionStatus {
  switch (status) {
    case "active":
    case "trialing":
      return "ACTIVE";
    case "canceled":
      return "CANCELED";
    case "incomplete_expired":
      return "EXPIRED";
    case "past_due":
    case "unpaid":
    case "incomplete":
    case "paused":
    default:
      return "PAST_DUE";
  }
}

/** Unix saniye → Date; geçersizse `fallback`. (`Date.now()*1000` hatası burada tekrarlanmaz.) */
export function unixToDate(seconds: unknown, fallback: Date): Date {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return fallback;
  return new Date(seconds * 1000);
}

/** Varsayılan 30 günlük dönem (Stripe dönem alanı yoksa). */
export function defaultPeriod(now = new Date()): { start: Date; end: Date } {
  return { start: now, end: new Date(now.getTime() + 30 * 86_400_000) };
}

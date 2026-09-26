import Stripe from "stripe";
import { prisma } from "@admedic/database";
import { loadEnv } from "@admedic/config";

import { PLAN_TABLE, STRIPE_API_VERSION, isPlanCode, planPriceId, type PlanCode } from "./plans";

export * from "./plans";

let _stripe: Stripe | null = null;

/**
 * Tek Stripe istemcisi. API sürümü `STRIPE_API_VERSION` sabitinden gelir (web checkout/webhook ile aynı).
 * Not: bu paketin `stripe` bağımlılığı (v16) daha eski bir sürüm tipi taşır; sürüm eşitliği için
 * sabit `LatestApiVersion` olarak daraltılır. Bağımlılık ^22'ye yükseltildiğinde daraltma kalkar.
 */
export function getStripe(): Stripe {
  if (!_stripe) {
    const env = loadEnv();
    if (!env.STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY env değişkeni ayarlanmamış.");
    _stripe = new Stripe(env.STRIPE_SECRET_KEY, {
      apiVersion: STRIPE_API_VERSION as unknown as Stripe.LatestApiVersion,
    });
  }
  return _stripe;
}

/** Geriye dönük ad: plan tablosu (`PLAN_TABLE` ile aynı nesne). */
export const PLANS = PLAN_TABLE;

export async function getOrCreateStripeCustomer(orgId: string, email?: string): Promise<string> {
  const existing = await prisma.stripeCustomer.findUnique({ where: { organizationId: orgId } });
  if (existing?.customerId) return existing.customerId;
  const customer = await getStripe().customers.create({
    ...(email ? { email } : {}),
    metadata: { organizationId: orgId },
  });
  await prisma.stripeCustomer.create({ data: { organizationId: orgId, customerId: customer.id } });
  return customer.id;
}

/**
 * Hosted Checkout oturumu (abonelik modu). Ödeme tamamlanmadan abonelik ACTIVE yapılmaz;
 * etkinleştirme `checkout.session.completed` webhook'unda olur. `metadata.organizationId`
 * webhook'un tenant eşlemesi için zorunludur.
 */
export async function createStripeCheckoutSession(input: {
  organizationId: string;
  customerId: string;
  plan: PlanCode;
}): Promise<string> {
  if (!isPlanCode(input.plan)) throw new Error(`Geçersiz plan: ${String(input.plan)}`);
  const env = loadEnv();
  const price = planPriceId(input.plan, env);
  if (!price) throw new Error(`${input.plan} planı için STRIPE_PRICE_* ayarlanmamış.`);
  const session = await getStripe().checkout.sessions.create({
    customer: input.customerId,
    payment_method_types: ["card"],
    line_items: [{ price, quantity: 1 }],
    mode: "subscription",
    success_url: env.STRIPE_SUCCESS_URL ?? `${env.AUTH_URL}/billing?status=paid`,
    cancel_url: env.STRIPE_CANCEL_URL ?? `${env.AUTH_URL}/billing?status=cancel`,
    metadata: { organizationId: input.organizationId, plan: input.plan },
    subscription_data: { metadata: { organizationId: input.organizationId, plan: input.plan } },
  });
  return session.url ?? "";
}

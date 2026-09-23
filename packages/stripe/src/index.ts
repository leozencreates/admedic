import Stripe from "stripe";
import { prisma } from "@admedic/database";
import { loadEnv } from "@admedic/config";

let _stripe: Stripe | null = null;
export function getStripe(): Stripe {
  if (!_stripe) {
    loadEnv();
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("STRIPE_SECRET_KEY env değişkeni ayarlanmamış.");
    _stripe = new Stripe(key, { apiVersion: "2024-06-20" });
  }
  return _stripe;
}

export interface PlanConfig {
  plan: string;
  priceId: string;
  amount: number;
  interval: string;
}

export const PLANS: Record<string, PlanConfig> = {
  FREE: { plan: "FREE", priceId: process.env.STRIPE_PRICE_FREE ?? "", amount: 0, interval: "month" },
  STARTER: { plan: "STARTER", priceId: process.env.STRIPE_PRICE_STARTER ?? "", amount: 2990, interval: "month" },
  PROFESSIONAL: { plan: "PROFESSIONAL", priceId: process.env.STRIPE_PRICE_PROFESSIONAL ?? "", amount: 9990, interval: "month" },
  ENTERPRISE: { plan: "ENTERPRISE", priceId: process.env.STRIPE_PRICE_ENTERPRISE ?? "", amount: 24990, interval: "month" },
};

export async function getOrCreateStripeCustomer(orgId: string, email: string): Promise<string> {
  const existing = await prisma.stripeCustomer.findFirst({ where: { organizationId: orgId } });
  if (existing?.customerId) return existing.customerId;
  const customer = await getStripe().customers.create({ email, metadata: { organizationId: orgId } });
  await prisma.stripeCustomer.create({ data: { organizationId: orgId, customerId: customer.id } });
  return customer.id;
}

export async function createStripeCheckoutSession(customerId: string, plan: string): Promise<string> {
  const config = PLANS[plan];
  if (!config) throw new Error(`Geçersiz plan: ${plan}`);
  const session = await getStripe().checkout.sessions.create({
    customer: customerId,
    payment_method_types: ["card"],
    line_items: [{ price: config.priceId, quantity: 1 }],
    mode: "subscription",
    success_url: process.env.STRIPE_SUCCESS_URL ?? "http://localhost:3000/billing?status=paid",
    cancel_url: process.env.STRIPE_CANCEL_URL ?? "http://localhost:3000/billing?status=cancel",
    metadata: { organizationId: customerId },
  });
  return session.url ?? "";
}

import { prisma } from "@admedic/database";
import { requireActor } from "../../../../_lib/auth";
import { body, respond, sameOrigin } from "../../../../_lib/http";
import { z } from "zod";
import Stripe from "stripe";
import { loadEnv } from "@admedic/config";
const PLAN_MAP: Record<string, { amount: number; interval: string }> = {
  FREE: { amount: 0, interval: "month" },
  STARTER: { amount: 2990, interval: "month" },
  PROFESSIONAL: { amount: 9990, interval: "month" },
  ENTERPRISE: { amount: 24990, interval: "month" },
};
export const maxDuration = 30;
const CheckoutSchema = z.object({ plan: z.enum(["FREE", "STARTER", "PROFESSIONAL", "ENTERPRISE"]) }).strict();
let _stripe: Stripe | null = null;
function getStripe(): Stripe {
  if (!_stripe) { loadEnv(); _stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "", ); }
  return _stripe;
}
export async function POST(request: Request) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    const input = await body(request, CheckoutSchema);
    const url = input.plan === "FREE" ? "" : "";
    await prisma.subscription.upsert({
      where: { organizationId: actor.orgId },
      update: { plan: input.plan, status: "ACTIVE" as const, currentPeriodStart: new Date() },
      create: { organizationId: actor.orgId, plan: input.plan, status: "ACTIVE" as const, currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 86400000) },
    });
    return { checkoutUrl: url, plan: input.plan, status: "ACTIVE" };
  });
}

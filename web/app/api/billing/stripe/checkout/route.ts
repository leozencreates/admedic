import { prisma } from "@admedic/database";
import { requireActor, requireRole } from "../../../../_lib/auth";
import { body, respond, sameOrigin, HttpError } from "../../../../_lib/http";
import { z } from "zod";
import Stripe from "stripe";
import { loadEnv } from "@admedic/config";
import { logAudit } from "../../../../_lib/audit";

export const maxDuration = 30;
const CheckoutSchema = z.object({ plan: z.enum(["FREE", "STARTER", "PROFESSIONAL", "ENTERPRISE"]) }).strict();
let _stripe: Stripe | null = null;
function getStripe(): Stripe {
  if (!_stripe) {
    const env = loadEnv();
    _stripe = new Stripe(env.STRIPE_SECRET_KEY ?? "", { apiVersion: "2026-08-26.dahlia" });
  }
  return _stripe;
}

export async function POST(request: Request) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, ["OWNER", "ADMIN"]);
    const input = await body(request, CheckoutSchema);
    const env = loadEnv();

    let checkoutUrl = "";
    let mock = false;
    if (input.plan !== "FREE" && env.STRIPE_SECRET_KEY && env.STRIPE_PRICE_STARTER) {
      let stripeCustomerId: string;
      const existing = await prisma.stripeCustomer.findUnique({ where: { organizationId: actor.orgId } });
      if (existing) {
        stripeCustomerId = existing.customerId;
      } else {
        const customer = await getStripe().customers.create({
          metadata: { organizationId: actor.orgId },
        });
        stripeCustomerId = customer.id;
        await prisma.stripeCustomer.create({ data: { organizationId: actor.orgId, customerId: stripeCustomerId } });
      }

      const result = await getStripe().checkout.sessions
        .create({
          customer: stripeCustomerId,
          payment_method_types: ["card"],
          line_items: [{ price: env.STRIPE_PRICE_STARTER, quantity: 1 }],
          mode: "subscription",
          success_url: env.STRIPE_SUCCESS_URL ?? "http://localhost:3000/billing?status=paid",
          cancel_url: env.STRIPE_CANCEL_URL ?? "http://localhost:3000/billing?status=cancel",
          metadata: { organizationId: actor.orgId, plan: input.plan },
        })
        .catch(() => null);
      checkoutUrl = result?.url ?? "";
    } else if (input.plan !== "FREE") {
      mock = true;
    }

    await prisma.subscription.upsert({
      where: { organizationId: actor.orgId },
      update: { plan: input.plan, status: "ACTIVE" as const, currentPeriodStart: new Date() },
      create: { organizationId: actor.orgId, plan: input.plan, status: "ACTIVE" as const, currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 86400000) },
    });
    await logAudit({
      actor,
      action: "PLAN_CHANGED",
      entityType: "SUBSCRIPTION",
      after: { plan: input.plan, status: "ACTIVE", checkoutUrl: checkoutUrl ? "(checkout)" : "free", mock },
    });
    return { checkoutUrl, plan: input.plan, status: "ACTIVE" as const, mock };
  });
}
import { prisma } from "@admedic/database";
import { respond } from "../../../../_lib/http";
import { headers } from "next/headers";
import Stripe from "stripe";
import { loadEnv } from "@admedic/config";
let _stripe: Stripe | null = null;
function getStripe(): Stripe {
  if (!_stripe) { loadEnv(); _stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "", ); }
  return _stripe;
}

function subWhere(input: { id?: string | null; organizationId?: string | null }) {
  if (input.id) return { stripeSubscriptionId: input.id };
  if (input.organizationId) return { organizationId: input.organizationId };
  return null;
}

export const maxDuration = 30;
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const body = await request.text();
  const headersList = await headers();
  const sig = headersList.get("stripe-signature");
  let event: Stripe.Event;
  if (sig && process.env.STRIPE_WEBHOOK_SECRET) {
    const stripe = getStripe();
    try { event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET); }
    catch { return new Response("Invalid signature", { status: 400 }); }
  } else {
    try { event = JSON.parse(body) as Stripe.Event; }
    catch { return new Response("Invalid payload", { status: 400 }); }
  }
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const orgId = session.metadata?.organizationId;
      if (!orgId) break;
      const plan = (session.metadata?.plan as "FREE" | "STARTER" | "PROFESSIONAL" | "ENTERPRISE") ?? "STARTER";
      const stripeSubId = session.subscription ? String(session.subscription) : null;
      const now = new Date();
      await prisma.subscription.upsert({
        where: { organizationId: orgId },
        update: { status: "ACTIVE", plan, currentPeriodStart: now, currentPeriodEnd: new Date(now.getTime() + 30 * 86400000), ...(stripeSubId ? { stripeSubscriptionId: stripeSubId } : {}) },
        create: { organizationId: orgId, plan, status: "ACTIVE", currentPeriodStart: now, currentPeriodEnd: new Date(now.getTime() + 30 * 86400000), ...(stripeSubId ? { stripeSubscriptionId: stripeSubId } : {}) },
      });
      break;
    }
    case "invoice.payment_succeeded": {
      const invoice = event.data.object as Stripe.Invoice & { subscription?: string | Stripe.Subscription | null };
      const where = subWhere({ id: typeof invoice.subscription === "string" ? invoice.subscription : invoice.subscription?.id });
      if (!where) break;
      const sub = await prisma.subscription.findFirst({ where });
      if (!sub) break;
      await prisma.subscription.update({ where: { id: sub.id }, data: { status: "ACTIVE" } });
      const existingInvoice = await prisma.invoice.findFirst({ where: { subscriptionId: sub.id } });
      if (existingInvoice) {
        await prisma.invoice.update({ where: { id: existingInvoice.id }, data: { status: "PAID", paidAt: new Date() } });
      } else {
        await prisma.invoice.create({
          data: {
            subscriptionId: sub.id,
            organizationId: sub.organizationId,
            amountCents: invoice.amount_paid ?? 0,
            currency: (invoice.currency ?? "EUR").toUpperCase(),
            status: "PAID", issuedAt: new Date(),
            dueAt: new Date(), paidAt: new Date(),
          },
        });
      }
      break;
    }
    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice & { subscription?: string | Stripe.Subscription | null };
      const where = subWhere({ id: typeof invoice.subscription === "string" ? invoice.subscription : invoice.subscription?.id });
      if (!where) break;
      const sub = await prisma.subscription.findFirst({ where });
      if (!sub) break;
      await prisma.subscription.update({ where: { id: sub.id }, data: { status: "PAST_DUE" } });
      break;
    }
    case "customer.subscription.deleted": {
      const raw = event.data.object as Stripe.Subscription;
      const sub = raw as Stripe.Subscription & { current_period_start?: number; current_period_end?: number };
      const where = subWhere({ id: sub.id, organizationId: sub.metadata?.organizationId });
      if (!where) break;
      await prisma.subscription.updateMany({ where, data: { status: "CANCELED" } });
      break;
    }
    case "customer.subscription.updated": {
      const raw = event.data.object as Stripe.Subscription;
      const sub = raw as Stripe.Subscription & { current_period_start?: number; current_period_end?: number };
      const where = subWhere({ id: sub.id, organizationId: sub.metadata?.organizationId });
      if (!where) break;
      await prisma.subscription.updateMany({
        where,
        data: {
          status: sub.status === "active" ? "ACTIVE" : sub.status === "canceled" ? "CANCELED" : sub.status === "past_due" ? "PAST_DUE" : "ACTIVE",
          cancelAtPeriodEnd: sub.cancel_at_period_end,
          currentPeriodStart: new Date((sub.current_period_start ?? Date.now()) * 1000),
          currentPeriodEnd: new Date((sub.current_period_end ?? Date.now()) * 1000),
        },
      });
      break;
    }
  }
  return new Response(JSON.stringify({ received: true }), { headers: { "Content-Type": "application/json" } });
}
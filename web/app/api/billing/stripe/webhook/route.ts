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
export const maxDuration = 30;
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const body = await request.text();
  const headersList = await headers();
  const sig = headersList.get("stripe-signature");
  if (!sig) return new Response("Missing signature", { status: 400 });
  const stripe = getStripe();
  let event: Stripe.Event;
  try { event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET ?? ""); }
  catch { return new Response("Invalid signature", { status: 400 }); }
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const orgId = session.metadata?.organizationId;
      if (orgId) await prisma.subscription.updateMany({ where: { organizationId: orgId }, data: { status: "ACTIVE", currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 86400000) } });
      break;
    }
    case "invoice.payment_succeeded": {
      const invoice = event.data.object as Stripe.Invoice & { subscription?: Stripe.Subscription };
      const sub = invoice.subscription as Stripe.Subscription;
      await prisma.invoice.updateMany({ where: { subscriptionId: sub?.id }, data: { status: "PAID", paidAt: new Date() } });
      break;
    }
    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice & { subscription?: Stripe.Subscription };
      const sub = invoice.subscription as Stripe.Subscription;
      await prisma.subscription.updateMany({ where: { organizationId: sub?.metadata?.organizationId ?? "" }, data: { status: "PAST_DUE" } });
      break;
    }
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      await prisma.subscription.updateMany({ where: { organizationId: sub.metadata?.organizationId ?? "" }, data: { status: "CANCELED" } });
      break;
    }
  }
  return new Response(JSON.stringify({ received: true }), { headers: { "Content-Type": "application/json" } });
}

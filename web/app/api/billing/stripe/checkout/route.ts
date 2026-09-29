import { z } from "zod";
import { prisma } from "@admedic/database";
import { requireActor, requireRole } from "../../../../_lib/auth";
import { body, respond, sameOrigin, HttpError } from "../../../../_lib/http";
import { logAudit } from "../../../../_lib/audit";
import { PlanSchema, billingMode, getStripe, isPaidPlan, planPriceId } from "../../_lib/stripe";
import { activateFreePlan, applyPlanLocally, serializeSubscription } from "../../_lib/billing";
import { logger } from "../../../../_lib/log";

/**
 * Plan seçimi / Stripe Checkout (spec 3.12). OWNER/ADMIN.
 * - FREE: ödeme gerektirmez, hemen ACTIVE (Stripe ile yönetilen açık bir abonelik varsa 409).
 * - Ücretli plan, gerçek mod: Stripe Checkout oturumu açılır ve `checkoutUrl` döner; abonelik
 *   ödeme tamamlanmadan ACTIVE yapılmaz — etkinleştirme `checkout.session.completed` webhook'unda.
 * - Ücretli plan, mock mod (`STRIPE_SECRET_KEY` yok VE production değil): Stripe'a gidilmez; plan
 *   ödeme beklemede (PAST_DUE) kaydedilir, plan tablosundaki tutarla DRAFT fatura açılır ve
 *   `mock: true` döner. Ödeme `POST /api/billing/invoices { action: "mark-paid" }` ile simüle edilir.
 */
export const maxDuration = 30;
const CheckoutSchema = z.object({ plan: PlanSchema }).strict();

export async function POST(request: Request) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, ["OWNER", "ADMIN"]);
    const input = await body(request, CheckoutSchema);
    const { mock, env } = billingMode();
    const existing = await prisma.subscription.findUnique({ where: { organizationId: actor.orgId } });
    const before = existing ? { plan: existing.plan, status: existing.status } : null;

    if (!isPaidPlan(input.plan)) {
      if (!mock && existing?.stripeSubscriptionId && existing.status !== "CANCELED" && existing.status !== "EXPIRED") {
        throw new HttpError(409, "Stripe ile yönetilen ücretli abonelik açıkken Ücretsiz plana geçilemez; önce aboneliği Stripe üzerinden iptal edin.");
      }
      const subscription = await prisma.$transaction(async (tx) => {
        const sub = await activateFreePlan(tx, actor.orgId);
        await logAudit(
          { actor, action: "PLAN_CHANGED", entityType: "SUBSCRIPTION", entityId: sub.id, before, after: { plan: "FREE", status: "ACTIVE", mock } },
          tx,
        );
        return sub;
      });
      return { checkoutUrl: "", plan: input.plan, status: subscription.status, mock, subscription: serializeSubscription(subscription) };
    }

    if (mock) {
      const result = await prisma.$transaction(async (tx) => {
        const applied = await applyPlanLocally(tx, actor.orgId, input.plan);
        await logAudit(
          {
            actor,
            action: "PLAN_CHANGED",
            entityType: "SUBSCRIPTION",
            entityId: applied.subscription.id,
            before,
            after: { plan: input.plan, status: applied.subscription.status, invoiceId: applied.invoice?.id ?? null, mock: true },
          },
          tx,
        );
        return applied;
      });
      return {
        checkoutUrl: "",
        plan: input.plan,
        status: result.subscription.status,
        mock: true,
        invoiceId: result.invoice?.id ?? null,
        subscription: serializeSubscription(result.subscription),
      };
    }

    // Gerçek mod: Stripe Checkout. Yerel abonelik dokunulmaz; webhook etkinleştirir.
    const price = planPriceId(input.plan, env);
    if (!price) throw new HttpError(503, `${input.plan} planı için STRIPE_PRICE_* ayarlanmadı. Sistem yöneticinize bildirin.`);
    const stripe = getStripe(env);
    let customerId: string;
    const customer = await prisma.stripeCustomer.findUnique({ where: { organizationId: actor.orgId } });
    if (customer) {
      customerId = customer.customerId;
    } else {
      const created = await stripe.customers.create({ metadata: { organizationId: actor.orgId } });
      customerId = created.id;
      await prisma.stripeCustomer.create({ data: { organizationId: actor.orgId, customerId } });
    }
    let session: Awaited<ReturnType<typeof stripe.checkout.sessions.create>>;
    try {
      session = await stripe.checkout.sessions.create({
        customer: customerId,
        payment_method_types: ["card"],
        line_items: [{ price, quantity: 1 }],
        mode: "subscription",
        success_url: env.STRIPE_SUCCESS_URL ?? `${env.AUTH_URL}/billing?status=paid`,
        cancel_url: env.STRIPE_CANCEL_URL ?? `${env.AUTH_URL}/billing?status=cancel`,
        metadata: { organizationId: actor.orgId, plan: input.plan },
        subscription_data: { metadata: { organizationId: actor.orgId, plan: input.plan } },
      });
    } catch (error) {
      logger.error(`[billing] Stripe checkout oturumu açılamadı: ${error instanceof Error ? error.message.slice(0, 200) : "unknown"}`);
      throw new HttpError(502, "Stripe Checkout oturumu açılamadı; daha sonra tekrar deneyin.");
    }
    if (!session.url) throw new HttpError(502, "Stripe ödeme sayfası bağlantısı alınamadı. Birkaç dakika sonra tekrar deneyin.");
    await logAudit({
      actor,
      action: "CHECKOUT_STARTED",
      entityType: "SUBSCRIPTION",
      entityId: existing?.id ?? null,
      before,
      after: { plan: input.plan, sessionId: session.id, mock: false },
    });
    return {
      checkoutUrl: session.url,
      plan: input.plan,
      status: existing?.status ?? null,
      mock: false,
      subscription: existing ? serializeSubscription(existing) : null,
    };
  });
}

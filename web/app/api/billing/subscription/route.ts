import { z } from "zod";
import { prisma } from "@admedic/database";
import { requireActor, requireRole } from "../../../_lib/auth";
import { body, respond, sameOrigin, HttpError } from "../../../_lib/http";
import { logAudit } from "../../../_lib/audit";
import { PlanSchema, billingMode, listPlans } from "../_lib/stripe";
import { applyPlanLocally, serializeSubscription } from "../_lib/billing";

export const maxDuration = 10;
const UpdateSubscriptionSchema = z.object({ plan: PlanSchema }).strict();

/** Abonelik + plan tablosu. Aboneliği olmayan kuruluş için `subscription: null` (404 değil). */
export async function GET() {
  return respond(async () => {
    const actor = await requireActor();
    const { mock } = billingMode();
    const sub = await prisma.subscription.findUnique({ where: { organizationId: actor.orgId } });
    return { subscription: sub ? serializeSubscription(sub) : null, plans: listPlans(), mock };
  });
}

/**
 * Stripe dışı plan değişikliği (yalnızca mock mod). OWNER/ADMIN + audit. Tutar plan tablosundan gelir;
 * ücretli plan ödeme beklemede (PAST_DUE) kalır ve DRAFT fatura açılır. Gerçek modda plan değişikliği
 * Stripe Checkout (`POST /api/billing/stripe/checkout`) üzerinden yapılır → 409.
 */
export async function PATCH(request: Request) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, ["OWNER", "ADMIN"]);
    const input = await body(request, UpdateSubscriptionSchema);
    const { mock } = billingMode();
    if (!mock) throw new HttpError(409, "Plan değişikliği Stripe Checkout üzerinden yapılır (POST /api/billing/stripe/checkout).");
    const existing = await prisma.subscription.findUnique({ where: { organizationId: actor.orgId } });
    const result = await prisma.$transaction(async (tx) => {
      const applied = await applyPlanLocally(tx, actor.orgId, input.plan);
      await logAudit(
        {
          actor,
          action: "PLAN_CHANGED",
          entityType: "SUBSCRIPTION",
          entityId: applied.subscription.id,
          before: existing ? { plan: existing.plan, status: existing.status } : null,
          after: { plan: input.plan, status: applied.subscription.status, invoiceId: applied.invoice?.id ?? null, mock: true },
        },
        tx,
      );
      return applied;
    });
    return { subscription: serializeSubscription(result.subscription), invoiceId: result.invoice?.id ?? null, mock: true };
  });
}

import { type Prisma, type Invoice, type Subscription } from "@admedic/database";
import { PLAN_TABLE, isPaidPlan, type PlanCode } from "./stripe";

type Db = Prisma.TransactionClient;

/** Bir aylık dönem: `start` → aynı gün bir sonraki ay. */
export function monthlyPeriod(start = new Date()): { start: Date; end: Date } {
  const end = new Date(start);
  end.setMonth(end.getMonth() + 1);
  return { start, end };
}

/** Ücretsiz plan ödeme gerektirmez: hemen ACTIVE; açık taslak faturalar VOID olur. */
export async function activateFreePlan(db: Db, organizationId: string): Promise<Subscription> {
  const period = monthlyPeriod();
  const subscription = await db.subscription.upsert({
    where: { organizationId },
    update: { plan: "FREE", status: "ACTIVE", currentPeriodStart: period.start, currentPeriodEnd: period.end, cancelAtPeriodEnd: false },
    create: { organizationId, plan: "FREE", status: "ACTIVE", currentPeriodStart: period.start, currentPeriodEnd: period.end },
  });
  await db.invoice.updateMany({
    where: { organizationId, subscriptionId: subscription.id, status: { in: ["DRAFT", "OVERDUE"] } },
    data: { status: "VOID" },
  });
  return subscription;
}

/**
 * Stripe olmadan (mock mod) plan değişikliği: plan kaydedilir, ücretli planda abonelik
 * ödeme beklemede (PAST_DUE) kalır ve plan tablosundaki tutarla DRAFT fatura açılır.
 * Ödeme tamamlanmadan (fatura PAID olmadan) abonelik ACTIVE yapılmaz.
 */
export async function applyPlanLocally(
  db: Db,
  organizationId: string,
  plan: PlanCode,
): Promise<{ subscription: Subscription; invoice: Invoice | null }> {
  if (!isPaidPlan(plan)) return { subscription: await activateFreePlan(db, organizationId), invoice: null };
  const definition = PLAN_TABLE[plan];
  const period = monthlyPeriod();
  const subscription = await db.subscription.upsert({
    where: { organizationId },
    update: { plan, status: "PAST_DUE", currentPeriodStart: period.start, currentPeriodEnd: period.end, cancelAtPeriodEnd: false },
    create: { organizationId, plan, status: "PAST_DUE", currentPeriodStart: period.start, currentPeriodEnd: period.end },
  });
  // Önceki plan için açık kalan taslaklar geçersiz; yeni plan için tek taslak fatura.
  await db.invoice.updateMany({
    where: { organizationId, subscriptionId: subscription.id, status: { in: ["DRAFT", "OVERDUE"] } },
    data: { status: "VOID" },
  });
  const invoice = await db.invoice.create({
    data: {
      subscriptionId: subscription.id,
      organizationId,
      amountCents: definition.amountCents,
      currency: definition.currency,
      status: "DRAFT",
      issuedAt: period.start,
      dueAt: period.end,
    },
  });
  return { subscription, invoice };
}

/** Faturayı ödenmiş işaretler ve aboneliği yeni dönemle etkinleştirir (mock modda elle ödeme). */
export async function markInvoicePaid(db: Db, invoice: Invoice, paidAt = new Date()): Promise<Invoice> {
  const updated = await db.invoice.update({ where: { id: invoice.id }, data: { status: "PAID", paidAt } });
  const period = monthlyPeriod(paidAt);
  await db.subscription.update({
    where: { id: invoice.subscriptionId },
    data: { status: "ACTIVE", currentPeriodStart: period.start, currentPeriodEnd: period.end },
  });
  return updated;
}

export function serializeSubscription(sub: Subscription) {
  return {
    plan: sub.plan,
    status: sub.status,
    currentPeriodStart: sub.currentPeriodStart,
    currentPeriodEnd: sub.currentPeriodEnd,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    stripeManaged: Boolean(sub.stripeSubscriptionId),
  };
}

export function serializeInvoice(inv: Invoice) {
  return {
    id: inv.id,
    amountCents: inv.amountCents,
    currency: inv.currency,
    status: inv.status,
    issuedAt: inv.issuedAt,
    dueAt: inv.dueAt,
    paidAt: inv.paidAt,
  };
}

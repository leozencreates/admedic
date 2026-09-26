import Stripe from "stripe";
import { z } from "zod";
import { prisma, Prisma, type Invoice, type Subscription } from "@admedic/database";
import { loadEnv } from "@admedic/config";
import { HttpError, respond } from "../../../../_lib/http";
import {
  PlanSchema,
  defaultPeriod,
  mapStripeSubscriptionStatus,
  unixToDate,
  billingMode,
  type PlanCode,
} from "../../_lib/stripe";

/**
 * Stripe webhook (spec 3.12).
 * - İmza: `stripe-signature` başlığı + `STRIPE_WEBHOOK_SECRET` ile doğrulanır; başlık veya secret
 *   yoksa **fail-closed 401**. Tek istisna mock/dev: `META_MOCK_MODE=true` VE `NODE_ENV!=="production"`
 *   iken imzasız gövde kabul edilir, yanıt `{ mock: true }` taşır ve durum açıkça loglanır.
 * - Dedupe: şemada olay tablosu yok; işlenen her olay `AuditLog` içinde `action:"STRIPE_EVENT"`,
 *   `entityId: event.id` olarak kaydedilir. Aynı `event.id` ikinci kez gelirse 200 `{ duplicate: true }`.
 *   Eşzamanlı teslimatlar olay kimliği üzerinden advisory lock ile sıraya alınır.
 * - Fatura eşlemesi: `Invoice.stripeInvoiceId` sütunu yok; Stripe fatura kimliği → yerel fatura eşlemesi
 *   `AuditLog(action:"STRIPE_INVOICE", entityId: <stripe invoice id>, after.invoiceId)` üzerinden tutulur.
 * - Abonelik durumu `mapStripeSubscriptionStatus` ile eşlenir; ödenmemiş durumlar ACTIVE'e düşmez.
 * - Tenant'a bağlanamayan olaylar 200 `{ ignored: true }` döner (Stripe'ın sonsuz yeniden denemesi önlenir);
 *   veritabanı hataları 503 → Stripe yeniden dener.
 */
export const maxDuration = 30;
export const dynamic = "force-dynamic";

const STRIPE_EVENT_ACTION = "STRIPE_EVENT";
const STRIPE_INVOICE_ACTION = "STRIPE_INVOICE";

const IdRef = z.union([z.string().min(1), z.object({ id: z.string().min(1) }).passthrough()]);
const Metadata = z.record(z.string(), z.string()).nullable().optional();

const EventSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    data: z.object({ object: z.record(z.string(), z.unknown()) }).passthrough(),
  })
  .passthrough();

const CheckoutSessionSchema = z
  .object({
    id: z.string().min(1),
    mode: z.string().optional(),
    payment_status: z.string().optional(),
    subscription: IdRef.nullable().optional(),
    customer: IdRef.nullable().optional(),
    metadata: Metadata,
  })
  .passthrough();

const InvoiceSchema = z
  .object({
    id: z.string().min(1),
    amount_paid: z.number().int().nonnegative().optional(),
    amount_due: z.number().int().nonnegative().optional(),
    currency: z.string().min(3).max(3).optional(),
    subscription: IdRef.nullable().optional(),
    metadata: Metadata,
    parent: z
      .object({
        subscription_details: z
          .object({ subscription: IdRef.nullable().optional(), metadata: Metadata })
          .passthrough()
          .nullable()
          .optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

const StripeSubscriptionSchema = z
  .object({
    id: z.string().min(1),
    status: z.string().min(1),
    cancel_at_period_end: z.boolean().optional(),
    current_period_start: z.number().optional(),
    current_period_end: z.number().optional(),
    items: z
      .object({
        data: z.array(
          z.object({ current_period_start: z.number().optional(), current_period_end: z.number().optional() }).passthrough(),
        ),
      })
      .passthrough()
      .optional(),
    metadata: Metadata,
  })
  .passthrough();

type StripeEvent = z.infer<typeof EventSchema>;
type Db = Prisma.TransactionClient;
type Outcome = { orgId: string | null; summary: Record<string, unknown> };

function refId(ref: z.infer<typeof IdRef> | null | undefined): string | null {
  if (!ref) return null;
  return typeof ref === "string" ? ref : ref.id;
}

function planFromMetadata(metadata: Record<string, string> | null | undefined): PlanCode | null {
  const parsed = PlanSchema.safeParse(metadata?.plan);
  return parsed.success ? parsed.data : null;
}

async function audit(db: Db, orgId: string, action: string, entityType: string, entityId: string | null, after: Prisma.InputJsonValue) {
  await db.auditLog.create({
    data: { orgId, workspaceId: null, userId: null, action, entityType, entityId, after },
  });
}

/** Stripe fatura kimliği → yerel fatura (AuditLog eşlemesi). */
async function findMappedInvoice(db: Db, stripeInvoiceId: string): Promise<Invoice | null> {
  const mapping = await db.auditLog.findFirst({
    where: { action: STRIPE_INVOICE_ACTION, entityId: stripeInvoiceId },
    orderBy: { createdAt: "desc" },
    select: { after: true },
  });
  const invoiceId = (mapping?.after as { invoiceId?: unknown } | null)?.invoiceId;
  if (typeof invoiceId !== "string") return null;
  return db.invoice.findUnique({ where: { id: invoiceId } });
}

async function resolveSubscriptionForInvoice(db: Db, invoice: z.infer<typeof InvoiceSchema>): Promise<Subscription | null> {
  const stripeSubscriptionId = refId(invoice.subscription) ?? refId(invoice.parent?.subscription_details?.subscription);
  if (stripeSubscriptionId) {
    const byStripeId = await db.subscription.findUnique({ where: { stripeSubscriptionId } });
    if (byStripeId) return byStripeId;
  }
  const orgId = invoice.metadata?.organizationId ?? invoice.parent?.subscription_details?.metadata?.organizationId;
  if (orgId) return db.subscription.findUnique({ where: { organizationId: orgId } });
  return null;
}

async function onCheckoutCompleted(db: Db, event: StripeEvent, mock: boolean): Promise<Outcome> {
  const parsed = CheckoutSessionSchema.safeParse(event.data.object);
  if (!parsed.success) return { orgId: null, summary: { ignored: true, reason: "checkout_session_shape" } };
  const session = parsed.data;
  const orgId = session.metadata?.organizationId;
  if (!orgId) return { orgId: null, summary: { ignored: true, reason: "missing_organization" } };
  const org = await db.organization.findUnique({ where: { id: orgId }, select: { id: true } });
  if (!org) return { orgId: null, summary: { ignored: true, reason: "unknown_organization" } };
  const plan = planFromMetadata(session.metadata);
  if (!plan) return { orgId, summary: { ignored: true, reason: "unknown_plan" } };
  if (session.payment_status && session.payment_status !== "paid" && session.payment_status !== "no_payment_required") {
    // Ödeme tamamlanmadan etkinleştirme yok; ödeme sonucu invoice.* olaylarıyla gelir.
    return { orgId, summary: { ignored: true, reason: `payment_status:${session.payment_status}` } };
  }
  const stripeSubscriptionId = refId(session.subscription);
  const existing = await db.subscription.findUnique({ where: { organizationId: orgId } });
  const period = defaultPeriod();
  const subscription = await db.subscription.upsert({
    where: { organizationId: orgId },
    update: {
      plan,
      status: "ACTIVE",
      cancelAtPeriodEnd: false,
      currentPeriodStart: period.start,
      currentPeriodEnd: period.end,
      ...(stripeSubscriptionId ? { stripeSubscriptionId } : {}),
    },
    create: {
      organizationId: orgId,
      plan,
      status: "ACTIVE",
      currentPeriodStart: period.start,
      currentPeriodEnd: period.end,
      ...(stripeSubscriptionId ? { stripeSubscriptionId } : {}),
    },
  });
  // Stripe ile ödenen plan için yerel taslak faturalar geçersizdir.
  await db.invoice.updateMany({
    where: { subscriptionId: subscription.id, status: { in: ["DRAFT", "OVERDUE"] } },
    data: { status: "VOID" },
  });
  await audit(db, orgId, "PLAN_CHANGED", "SUBSCRIPTION", subscription.id, {
    source: "stripe:checkout.session.completed",
    sessionId: session.id,
    before: existing ? { plan: existing.plan, status: existing.status } : null,
    after: { plan, status: "ACTIVE" },
    mock,
  });
  return { orgId, summary: { handled: event.type, plan, status: "ACTIVE" } };
}

async function onInvoicePaid(db: Db, event: StripeEvent, mock: boolean): Promise<Outcome> {
  const parsed = InvoiceSchema.safeParse(event.data.object);
  if (!parsed.success) return { orgId: null, summary: { ignored: true, reason: "invoice_shape" } };
  const stripeInvoice = parsed.data;
  const subscription = await resolveSubscriptionForInvoice(db, stripeInvoice);
  if (!subscription) return { orgId: null, summary: { ignored: true, reason: "unknown_subscription" } };
  const orgId = subscription.organizationId;
  const paidAt = new Date();
  const amountCents = stripeInvoice.amount_paid ?? stripeInvoice.amount_due ?? 0;
  const currency = (stripeInvoice.currency ?? "eur").toUpperCase();

  let invoice = await findMappedInvoice(db, stripeInvoice.id);
  if (!invoice) {
    // Eşleme yoksa aynı tutarlı açık yerel taslak varsa onu kapat; yoksa ödenmiş fatura oluştur.
    invoice = await db.invoice.findFirst({
      where: { subscriptionId: subscription.id, status: { in: ["DRAFT", "OVERDUE"] }, amountCents, currency },
      orderBy: { issuedAt: "desc" },
    });
  }
  if (invoice) {
    invoice = await db.invoice.update({ where: { id: invoice.id }, data: { status: "PAID", paidAt } });
  } else {
    invoice = await db.invoice.create({
      data: {
        subscriptionId: subscription.id,
        organizationId: orgId,
        amountCents,
        currency,
        status: "PAID",
        issuedAt: paidAt,
        dueAt: paidAt,
        paidAt,
      },
    });
  }
  // Ödeme, bekleyen/aktif aboneliği etkinleştirir; iptal edilmiş abonelik ödeme ile geri açılmaz
  // (durum değişiklikleri customer.subscription.* olaylarıyla gelir).
  const reactivate = subscription.status === "PAST_DUE" || subscription.status === "ACTIVE";
  if (reactivate) await db.subscription.update({ where: { id: subscription.id }, data: { status: "ACTIVE" } });
  const status = reactivate ? "ACTIVE" : subscription.status;
  await audit(db, orgId, STRIPE_INVOICE_ACTION, "INVOICE", stripeInvoice.id, { invoiceId: invoice.id, status: "PAID", mock });
  await audit(db, orgId, "INVOICE_PAID", "INVOICE", invoice.id, { source: `stripe:${event.type}`, amountCents, currency, mock });
  return { orgId, summary: { handled: event.type, invoiceId: invoice.id, status } };
}

async function onInvoicePaymentFailed(db: Db, event: StripeEvent, mock: boolean): Promise<Outcome> {
  const parsed = InvoiceSchema.safeParse(event.data.object);
  if (!parsed.success) return { orgId: null, summary: { ignored: true, reason: "invoice_shape" } };
  const stripeInvoice = parsed.data;
  const subscription = await resolveSubscriptionForInvoice(db, stripeInvoice);
  if (!subscription) return { orgId: null, summary: { ignored: true, reason: "unknown_subscription" } };
  const orgId = subscription.organizationId;
  const amountCents = stripeInvoice.amount_due ?? 0;
  const currency = (stripeInvoice.currency ?? "eur").toUpperCase();
  const now = new Date();
  let invoice = await findMappedInvoice(db, stripeInvoice.id);
  if (invoice && invoice.status !== "PAID") {
    invoice = await db.invoice.update({ where: { id: invoice.id }, data: { status: "OVERDUE" } });
  } else if (!invoice) {
    invoice = await db.invoice.create({
      data: { subscriptionId: subscription.id, organizationId: orgId, amountCents, currency, status: "OVERDUE", issuedAt: now, dueAt: now },
    });
    await audit(db, orgId, STRIPE_INVOICE_ACTION, "INVOICE", stripeInvoice.id, { invoiceId: invoice.id, status: "OVERDUE", mock });
  }
  await db.subscription.update({ where: { id: subscription.id }, data: { status: "PAST_DUE" } });
  await audit(db, orgId, "INVOICE_PAYMENT_FAILED", "INVOICE", invoice.id, { source: `stripe:${event.type}`, amountCents, currency, mock });
  return { orgId, summary: { handled: event.type, invoiceId: invoice.id, status: "PAST_DUE" } };
}

async function onSubscriptionChanged(db: Db, event: StripeEvent, mock: boolean): Promise<Outcome> {
  const parsed = StripeSubscriptionSchema.safeParse(event.data.object);
  if (!parsed.success) return { orgId: null, summary: { ignored: true, reason: "subscription_shape" } };
  const stripeSub = parsed.data;
  const deleted = event.type === "customer.subscription.deleted";
  const status = deleted ? "CANCELED" : mapStripeSubscriptionStatus(stripeSub.status);
  const item = stripeSub.items?.data[0];
  const startSec = stripeSub.current_period_start ?? item?.current_period_start;
  const endSec = stripeSub.current_period_end ?? item?.current_period_end;
  const metadataOrgId = stripeSub.metadata?.organizationId ?? null;
  const metadataPlan = planFromMetadata(stripeSub.metadata);

  let existing = await db.subscription.findUnique({ where: { stripeSubscriptionId: stripeSub.id } });
  if (!existing && metadataOrgId) existing = await db.subscription.findUnique({ where: { organizationId: metadataOrgId } });
  if (!existing) {
    if (deleted || !metadataOrgId || !metadataPlan) return { orgId: null, summary: { ignored: true, reason: "unknown_subscription" } };
    const org = await db.organization.findUnique({ where: { id: metadataOrgId }, select: { id: true } });
    if (!org) return { orgId: null, summary: { ignored: true, reason: "unknown_organization" } };
    const period = defaultPeriod();
    const created = await db.subscription.create({
      data: {
        organizationId: metadataOrgId,
        plan: metadataPlan,
        status,
        stripeSubscriptionId: stripeSub.id,
        cancelAtPeriodEnd: stripeSub.cancel_at_period_end ?? false,
        currentPeriodStart: unixToDate(startSec, period.start),
        currentPeriodEnd: unixToDate(endSec, period.end),
      },
    });
    await audit(db, metadataOrgId, "SUBSCRIPTION_SYNCED", "SUBSCRIPTION", created.id, {
      source: `stripe:${event.type}`, after: { plan: metadataPlan, status }, mock,
    });
    return { orgId: metadataOrgId, summary: { handled: event.type, status } };
  }
  // Farklı bir Stripe aboneliğine bağlı yerel kayıt varsa, eski aboneliğin olaylarını uygulama.
  if (existing.stripeSubscriptionId && existing.stripeSubscriptionId !== stripeSub.id) {
    return { orgId: existing.organizationId, summary: { ignored: true, reason: "stale_subscription" } };
  }
  const updated = await db.subscription.update({
    where: { id: existing.id },
    data: {
      status,
      cancelAtPeriodEnd: deleted ? false : (stripeSub.cancel_at_period_end ?? existing.cancelAtPeriodEnd),
      ...(metadataPlan && !deleted ? { plan: metadataPlan } : {}),
      ...(existing.stripeSubscriptionId ? {} : { stripeSubscriptionId: stripeSub.id }),
      ...(startSec ? { currentPeriodStart: unixToDate(startSec, existing.currentPeriodStart) } : {}),
      ...(endSec ? { currentPeriodEnd: unixToDate(endSec, existing.currentPeriodEnd) } : {}),
    },
  });
  await audit(db, existing.organizationId, "SUBSCRIPTION_SYNCED", "SUBSCRIPTION", updated.id, {
    source: `stripe:${event.type}`,
    stripeStatus: stripeSub.status,
    before: { plan: existing.plan, status: existing.status, cancelAtPeriodEnd: existing.cancelAtPeriodEnd },
    after: { plan: updated.plan, status: updated.status, cancelAtPeriodEnd: updated.cancelAtPeriodEnd },
    mock,
  });
  return { orgId: existing.organizationId, summary: { handled: event.type, status: updated.status } };
}

async function applyEvent(db: Db, event: StripeEvent, mock: boolean): Promise<Outcome> {
  switch (event.type) {
    case "checkout.session.completed":
      return onCheckoutCompleted(db, event, mock);
    case "invoice.paid":
    case "invoice.payment_succeeded":
      return onInvoicePaid(db, event, mock);
    case "invoice.payment_failed":
      return onInvoicePaymentFailed(db, event, mock);
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      return onSubscriptionChanged(db, event, mock);
    default:
      return { orgId: null, summary: { ignored: true, reason: "unhandled_type" } };
  }
}

/** Olayı tek transaction içinde, olay kimliği kilidi altında ve dedupe ile işler. */
export async function processStripeEvent(event: StripeEvent, mock: boolean): Promise<Record<string, unknown>> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"stripe-event"}), hashtext(${event.id}))`;
    const seen = await tx.auditLog.findFirst({
      where: { action: STRIPE_EVENT_ACTION, entityId: event.id },
      select: { id: true },
    });
    if (seen) return { duplicate: true };
    const outcome = await applyEvent(tx, event, mock);
    if (outcome.orgId) {
      await audit(tx, outcome.orgId, STRIPE_EVENT_ACTION, "STRIPE_EVENT", event.id, {
        type: event.type,
        mock,
        ...(outcome.summary as Record<string, Prisma.InputJsonValue>),
      });
    }
    return outcome.summary;
  });
}

export async function POST(request: Request) {
  return respond(async () => {
    const raw = await request.text();
    const env = loadEnv();
    const signature = request.headers.get("stripe-signature");
    let payload: unknown;
    let mock = false;
    if (signature && env.STRIPE_WEBHOOK_SECRET) {
      try {
        payload = Stripe.webhooks.constructEvent(raw, signature, env.STRIPE_WEBHOOK_SECRET);
      } catch {
        throw new HttpError(401, "Stripe webhook imzası doğrulanamadı.");
      }
    } else if (!env.STRIPE_WEBHOOK_SECRET && billingMode(env).mock) {
      // Yalnızca Stripe hiç yapılandırılmamışken (gizli anahtar VE webhook anahtarı yok, production dışı)
      // imzasız gövde kabul edilir. Gerçek Stripe anahtarı varsa imzasız istek her zaman 401.
      mock = true;
      console.warn("[billing] Stripe webhook imzasız kabul edildi (Stripe yapılandırılmamış, NODE_ENV!=production).");
      try {
        payload = JSON.parse(raw);
      } catch {
        throw new HttpError(400, "Geçersiz webhook gövdesi.");
      }
    } else {
      throw new HttpError(
        401,
        signature ? "STRIPE_WEBHOOK_SECRET ayarlanmadı; webhook reddedildi." : "Stripe imza başlığı eksik.",
      );
    }
    const parsed = EventSchema.safeParse(payload);
    if (!parsed.success) throw new HttpError(400, "Webhook olay biçimi geçersiz (id/type/data.object bekleniyor).");
    const result = await processStripeEvent(parsed.data, mock);
    return { received: true, ...result, ...(mock ? { mock: true } : {}) };
  });
}

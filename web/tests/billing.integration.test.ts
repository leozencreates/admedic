import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHmac, randomBytes } from "node:crypto";
import { prisma } from "@admedic/database";
import { loadEnv } from "@admedic/config";
import { tokenHash } from "../app/_lib/password";
import { SESSION_COOKIE } from "../app/_lib/auth";
import { mapStripeSubscriptionStatus, unixToDate, billingMode, PLAN_TABLE, planPriceId } from "../app/api/billing/_lib/stripe";

const { cookieJar } = vi.hoisted(() => ({ cookieJar: new Map<string, string>() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (key: string) => (cookieJar.has(key) ? { value: cookieJar.get(key) } : undefined),
    set: (key: string, value: string) => cookieJar.set(key, value),
    delete: (key: string) => cookieJar.delete(key),
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: () => {
    throw new Error("redirect");
  },
}));

import { POST as webhookPost } from "../app/api/billing/stripe/webhook/route";
import { POST as checkoutPost } from "../app/api/billing/stripe/checkout/route";
import { GET as subscriptionGet, PATCH as subscriptionPatch } from "../app/api/billing/subscription/route";
import { GET as invoicesGet, POST as invoicesPost } from "../app/api/billing/invoices/route";

const ORIGIN = "http://localhost:3000";

function req(url: string, method: string, bodyObj?: unknown) {
  return new Request(`${ORIGIN}${url}`, {
    method,
    headers: { origin: ORIGIN, "content-type": "application/json" },
    body: bodyObj === undefined ? undefined : JSON.stringify(bodyObj),
  });
}

function stripeSignature(payload: string, secret: string, timestamp = Math.floor(Date.now() / 1000)) {
  const v1 = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

function webhookRequest(event: unknown, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}/api/billing/stripe/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(event),
  });
}

function stripeEvent(type: string, object: Record<string, unknown>, id = `evt_${randomBytes(8).toString("hex")}`) {
  return { id, object: "event", type, data: { object } };
}

/**
 * Faturalandırma mock modu: Stripe hiç yapılandırılmamış (STRIPE_SECRET_KEY yok) ve production dışı.
 * mock=false için gerçek bir anahtar taklit edilir (webhook imzasız istekleri reddetmeli).
 */
function useMockMode(mock: boolean) {
  vi.stubEnv("STRIPE_SECRET_KEY", mock ? "" : "sk_test_fixture");
  loadEnv({ fresh: true });
}

describe("billing saf yardımcıları", () => {
  it("Stripe abonelik durumlarını ACTIVE'e düşürmeden eşler", () => {
    expect(mapStripeSubscriptionStatus("active")).toBe("ACTIVE");
    expect(mapStripeSubscriptionStatus("trialing")).toBe("ACTIVE");
    expect(mapStripeSubscriptionStatus("past_due")).toBe("PAST_DUE");
    expect(mapStripeSubscriptionStatus("unpaid")).toBe("PAST_DUE");
    expect(mapStripeSubscriptionStatus("incomplete")).toBe("PAST_DUE");
    expect(mapStripeSubscriptionStatus("paused")).toBe("PAST_DUE");
    expect(mapStripeSubscriptionStatus("canceled")).toBe("CANCELED");
    expect(mapStripeSubscriptionStatus("incomplete_expired")).toBe("EXPIRED");
    expect(mapStripeSubscriptionStatus("something-new")).toBe("PAST_DUE");
    expect(mapStripeSubscriptionStatus(undefined)).toBe("PAST_DUE");
  });
  it("unix saniyeyi tarihe çevirir; geçersizde yedeği kullanır (Date.now()*1000 hatası yok)", () => {
    const fallback = new Date("2026-01-01T00:00:00Z");
    expect(unixToDate(1_790_000_000, fallback).toISOString()).toBe(new Date(1_790_000_000 * 1000).toISOString());
    expect(unixToDate(undefined, fallback)).toBe(fallback);
    expect(unixToDate(-5, fallback)).toBe(fallback);
  });
  it("plan tablosu fiyat kimliklerini ortamdan okur", () => {
    expect(PLAN_TABLE.STARTER.amountCents).toBe(2990);
    expect(planPriceId("FREE", {})).toBeUndefined();
    expect(planPriceId("PROFESSIONAL", {})).toBeUndefined();
    expect(planPriceId("PROFESSIONAL", { STRIPE_PRICE_PROFESSIONAL: "price_123" })).toBe("price_123");
  });
  it("mock mod yalnızca STRIPE_SECRET_KEY yokken ve production değilken açıktır", () => {
    const base = loadEnv({ fresh: true });
    expect(billingMode({ ...base, STRIPE_SECRET_KEY: undefined, NODE_ENV: "test" }).mock).toBe(true);
    expect(billingMode({ ...base, STRIPE_SECRET_KEY: "sk_test_x", NODE_ENV: "test" }).mock).toBe(false);
    expect(billingMode({ ...base, STRIPE_SECRET_KEY: undefined, NODE_ENV: "production" }).mock).toBe(false);
  });
});

describe.skipIf(process.env.STUDIO_DB_TEST !== "1")("billing integration (checkout, webhook, roller)", () => {
  const suffix = randomBytes(6).toString("hex");
  const orgIds: string[] = [];
  const userIds: string[] = [];
  let orgA = "";
  let orgB = "";
  let tokenOwner = "";
  let tokenViewer = "";
  let tokenBuyer = "";
  let tokenOwnerB = "";

  beforeAll(async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "");
    vi.stubEnv("STRIPE_PRICE_STARTER", "");
    vi.stubEnv("STRIPE_PRICE_PROFESSIONAL", "");
    vi.stubEnv("STRIPE_PRICE_ENTERPRISE", "");
    useMockMode(true);
    const mkUser = async () =>
      prisma.user.create({ data: { email: `${randomBytes(4).toString("hex")}-${suffix}@example.invalid` } });
    const owner = await mkUser();
    const viewer = await mkUser();
    const buyer = await mkUser();
    const ownerB = await mkUser();
    userIds.push(owner.id, viewer.id, buyer.id, ownerB.id);
    const a = await prisma.organization.create({
      data: {
        name: "Billing fixture A",
        slug: `billfix-a-${suffix}`,
        members: {
          create: [
            { userId: owner.id, role: "OWNER" },
            { userId: viewer.id, role: "VIEWER" },
            { userId: buyer.id, role: "MEDIA_BUYER" },
          ],
        },
        workspaces: { create: { name: "Ws", slug: "ws-a" } },
      },
      include: { workspaces: true },
    });
    const b = await prisma.organization.create({
      data: {
        name: "Billing fixture B",
        slug: `billfix-b-${suffix}`,
        members: { create: { userId: ownerB.id, role: "OWNER" } },
        workspaces: { create: { name: "Ws", slug: "ws-b" } },
      },
      include: { workspaces: true },
    });
    orgA = a.id;
    orgB = b.id;
    orgIds.push(orgA, orgB);
    const session = async (userId: string, workspaceId: string) => {
      const t = randomBytes(32).toString("hex");
      await prisma.webSession.create({
        data: { tokenHash: tokenHash(t), userId, workspaceId, expiresAt: new Date(Date.now() + 60_000) },
      });
      return t;
    };
    tokenOwner = await session(owner.id, a.workspaces[0]!.id);
    tokenViewer = await session(viewer.id, a.workspaces[0]!.id);
    tokenBuyer = await session(buyer.id, a.workspaces[0]!.id);
    tokenOwnerB = await session(ownerB.id, b.workspaces[0]!.id);
  });

  afterAll(async () => {
    cookieJar.clear();
    await prisma.auditLog.deleteMany({ where: { orgId: { in: orgIds } } });
    await prisma.invoice.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.subscription.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.stripeCustomer.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    vi.unstubAllEnvs();
    loadEnv({ fresh: true });
    await prisma.$disconnect();
  });

  it("aboneliği olmayan kuruluş için GET 404 yerine subscription:null + plan tablosu döner", async () => {
    cookieJar.set(SESSION_COOKIE, tokenOwner);
    const res = await subscriptionGet();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.subscription).toBeNull();
    expect(json.plans.map((p: { code: string }) => p.code)).toEqual(["FREE", "STARTER", "PROFESSIONAL", "ENTERPRISE"]);
    expect(json.mock).toBe(true);
  });

  it("webhook: imza başlığı yoksa ve mock mod kapalıysa 401 (fail-closed)", async () => {
    useMockMode(false);
    const unsigned = await webhookPost(webhookRequest(stripeEvent("checkout.session.completed", { id: "cs_x" })));
    expect(unsigned.status).toBe(401);
    // İmza başlığı var ama STRIPE_WEBHOOK_SECRET yok → yine 401.
    const noSecret = await webhookPost(
      webhookRequest(stripeEvent("checkout.session.completed", { id: "cs_x" }), { "stripe-signature": "t=1,v1=abc" }),
    );
    expect(noSecret.status).toBe(401);
    useMockMode(true);
  });

  it("webhook: geçerli imza kabul edilir, bozuk imza 401", async () => {
    const secret = `whsec_${randomBytes(12).toString("hex")}`;
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", secret);
    useMockMode(false);
    const event = stripeEvent("customer.subscription.updated", { id: `sub_${suffix}_none`, status: "active" });
    const payload = JSON.stringify(event);
    const ok = await webhookPost(
      new Request(`${ORIGIN}/api/billing/stripe/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json", "stripe-signature": stripeSignature(payload, secret) },
        body: payload,
      }),
    );
    expect(ok.status).toBe(200);
    const okJson = await ok.json();
    expect(okJson.received).toBe(true);
    expect(okJson.mock).toBeUndefined();
    expect(okJson.ignored).toBe(true); // bilinmeyen abonelik → 200 ignored (Stripe yeniden denemesin)

    const bad = await webhookPost(
      new Request(`${ORIGIN}/api/billing/stripe/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json", "stripe-signature": stripeSignature(payload, "whsec_wrong") },
        body: payload,
      }),
    );
    expect(bad.status).toBe(401);
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "");
    useMockMode(true);
  });

  it("webhook (mock): imzasız gövde {mock:true} ile işlenir; şema hatası 400", async () => {
    const bad = await webhookPost(webhookRequest({ hello: "world" }));
    expect(bad.status).toBe(400);
    const unknown = await webhookPost(webhookRequest(stripeEvent("product.created", { id: "prod_1" })));
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toMatchObject({ received: true, ignored: true, mock: true });
  });

  it("checkout.session.completed aboneliği etkinleştirir; aynı event.id ikinci kez → duplicate", async () => {
    const eventId = `evt_${suffix}_checkout`;
    const event = stripeEvent(
      "checkout.session.completed",
      {
        id: `cs_${suffix}`,
        mode: "subscription",
        payment_status: "paid",
        subscription: `sub_${suffix}`,
        metadata: { organizationId: orgA, plan: "PROFESSIONAL" },
      },
      eventId,
    );
    const first = await webhookPost(webhookRequest(event));
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ received: true, handled: "checkout.session.completed", status: "ACTIVE", mock: true });
    const sub = await prisma.subscription.findUniqueOrThrow({ where: { organizationId: orgA } });
    expect(sub).toMatchObject({ plan: "PROFESSIONAL", status: "ACTIVE", stripeSubscriptionId: `sub_${suffix}` });

    const second = await webhookPost(webhookRequest(event));
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ received: true, duplicate: true, mock: true });
    const seen = await prisma.auditLog.count({ where: { orgId: orgA, action: "STRIPE_EVENT", entityId: eventId } });
    expect(seen).toBe(1);
    expect(await prisma.auditLog.count({ where: { orgId: orgA, action: "PLAN_CHANGED" } })).toBe(1);
  });

  it("ödenmemiş checkout oturumu aboneliği etkinleştirmez", async () => {
    const res = await webhookPost(
      webhookRequest(
        stripeEvent("checkout.session.completed", {
          id: `cs_${suffix}_unpaid`,
          payment_status: "unpaid",
          subscription: `sub_${suffix}_unpaid`,
          metadata: { organizationId: orgB, plan: "STARTER" },
        }),
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ignored: true });
    expect(await prisma.subscription.findUnique({ where: { organizationId: orgB } })).toBeNull();
  });

  it("customer.subscription.updated durumları doğru eşler ve dönemi Stripe'tan alır", async () => {
    const start = 1_800_000_000;
    const end = start + 30 * 86_400;
    const send = async (status: string) =>
      webhookPost(
        webhookRequest(
          stripeEvent("customer.subscription.updated", {
            id: `sub_${suffix}`,
            status,
            cancel_at_period_end: status === "active",
            items: { data: [{ current_period_start: start, current_period_end: end }] },
            metadata: { organizationId: orgA, plan: "PROFESSIONAL" },
          }),
        ),
      );
    for (const [stripeStatus, expected] of [
      ["unpaid", "PAST_DUE"],
      ["incomplete", "PAST_DUE"],
      ["past_due", "PAST_DUE"],
      ["canceled", "CANCELED"],
      ["incomplete_expired", "EXPIRED"],
      ["active", "ACTIVE"],
    ] as const) {
      expect((await send(stripeStatus)).status).toBe(200);
      const sub = await prisma.subscription.findUniqueOrThrow({ where: { organizationId: orgA } });
      expect(sub.status).toBe(expected);
    }
    const sub = await prisma.subscription.findUniqueOrThrow({ where: { organizationId: orgA } });
    expect(sub.cancelAtPeriodEnd).toBe(true);
    expect(sub.currentPeriodStart.getTime()).toBe(start * 1000);
    expect(sub.currentPeriodEnd.getTime()).toBe(end * 1000);

    const deleted = await webhookPost(
      webhookRequest(stripeEvent("customer.subscription.deleted", { id: `sub_${suffix}`, status: "canceled" })),
    );
    expect(deleted.status).toBe(200);
    const after = await prisma.subscription.findUniqueOrThrow({ where: { organizationId: orgA } });
    expect(after.status).toBe("CANCELED");
    expect(after.cancelAtPeriodEnd).toBe(false);
  });

  it("invoice.payment_succeeded ödenmiş fatura yazar, payment_failed PAST_DUE + gecikmiş fatura", async () => {
    // Aboneliği tekrar bekleyen duruma al (ödeme etkinleştirsin).
    await prisma.subscription.update({ where: { organizationId: orgA }, data: { status: "PAST_DUE" } });
    const stripeInvoiceId = `in_${suffix}_1`;
    const paid = await webhookPost(
      webhookRequest(
        stripeEvent("invoice.payment_succeeded", {
          id: stripeInvoiceId,
          amount_paid: 9990,
          currency: "eur",
          parent: { subscription_details: { subscription: `sub_${suffix}` } },
        }),
      ),
    );
    expect(paid.status).toBe(200);
    const paidJson = await paid.json();
    expect(paidJson.status).toBe("ACTIVE");
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: paidJson.invoiceId } });
    expect(invoice).toMatchObject({ organizationId: orgA, amountCents: 9990, currency: "EUR", status: "PAID" });
    expect(invoice.paidAt).not.toBeNull();
    expect((await prisma.subscription.findUniqueOrThrow({ where: { organizationId: orgA } })).status).toBe("ACTIVE");
    // Aynı Stripe faturası (farklı event.id) tekrar gelirse yeni fatura oluşmaz (AuditLog eşlemesi).
    const again = await webhookPost(
      webhookRequest(
        stripeEvent("invoice.paid", { id: stripeInvoiceId, amount_paid: 9990, currency: "eur", subscription: `sub_${suffix}` }),
      ),
    );
    expect((await again.json()).invoiceId).toBe(invoice.id);
    expect(await prisma.invoice.count({ where: { organizationId: orgA, status: "PAID" } })).toBe(1);

    const failed = await webhookPost(
      webhookRequest(
        stripeEvent("invoice.payment_failed", {
          id: `in_${suffix}_2`,
          amount_due: 9990,
          currency: "eur",
          subscription: `sub_${suffix}`,
        }),
      ),
    );
    expect(failed.status).toBe(200);
    expect(await failed.json()).toMatchObject({ status: "PAST_DUE" });
    expect((await prisma.subscription.findUniqueOrThrow({ where: { organizationId: orgA } })).status).toBe("PAST_DUE");
    expect(await prisma.invoice.count({ where: { organizationId: orgA, status: "OVERDUE" } })).toBe(1);
  });

  it("roller: VIEWER ve MEDIA_BUYER plan değiştiremez / fatura ödeyemez", async () => {
    cookieJar.set(SESSION_COOKIE, tokenViewer);
    expect((await subscriptionPatch(req("/api/billing/subscription", "PATCH", { plan: "STARTER" }))).status).toBe(403);
    expect((await checkoutPost(req("/api/billing/stripe/checkout", "POST", { plan: "STARTER" }))).status).toBe(403);
    expect((await invoicesPost(req("/api/billing/invoices", "POST", { invoiceId: "x", action: "mark-paid" }))).status).toBe(403);
    cookieJar.set(SESSION_COOKIE, tokenBuyer);
    expect((await subscriptionPatch(req("/api/billing/subscription", "PATCH", { plan: "STARTER" }))).status).toBe(403);
    expect((await invoicesPost(req("/api/billing/invoices", "POST", { invoiceId: "x", action: "mark-paid" }))).status).toBe(403);
  });

  it("mock checkout: ücretli plan ödeme beklemede kalır, taslak fatura açılır, mark-paid etkinleştirir", async () => {
    cookieJar.set(SESSION_COOKIE, tokenOwnerB);
    const res = await checkoutPost(req("/api/billing/stripe/checkout", "POST", { plan: "STARTER" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ checkoutUrl: "", plan: "STARTER", status: "PAST_DUE", mock: true });
    expect(json.invoiceId).toBeTruthy();
    const sub = await prisma.subscription.findUniqueOrThrow({ where: { organizationId: orgB } });
    expect(sub.status).toBe("PAST_DUE");
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: json.invoiceId } });
    expect(invoice).toMatchObject({ status: "DRAFT", amountCents: 2990, currency: "EUR" });

    const listed = await invoicesGet();
    expect((await listed.json()).invoices.map((i: { id: string }) => i.id)).toContain(invoice.id);

    // Başka tenant'ın faturası → 404.
    cookieJar.set(SESSION_COOKIE, tokenOwner);
    expect((await invoicesPost(req("/api/billing/invoices", "POST", { invoiceId: invoice.id, action: "mark-paid" }))).status).toBe(404);

    cookieJar.set(SESSION_COOKIE, tokenOwnerB);
    const paid = await invoicesPost(req("/api/billing/invoices", "POST", { invoiceId: invoice.id, action: "mark-paid" }));
    expect(paid.status).toBe(200);
    expect((await paid.json()).invoice.status).toBe("PAID");
    expect((await prisma.subscription.findUniqueOrThrow({ where: { organizationId: orgB } })).status).toBe("ACTIVE");
    expect(await prisma.auditLog.count({ where: { orgId: orgB, action: "INVOICE_PAID", entityId: invoice.id } })).toBe(1);
    expect((await invoicesPost(req("/api/billing/invoices", "POST", { invoiceId: invoice.id, action: "mark-paid" }))).status).toBe(409);

    // PATCH (mock): plan tablosundan tutar, audit; FREE hemen ACTIVE ve açık taslaklar VOID.
    const patched = await subscriptionPatch(req("/api/billing/subscription", "PATCH", { plan: "ENTERPRISE" }));
    expect(patched.status).toBe(200);
    const patchedJson = await patched.json();
    expect(patchedJson.subscription).toMatchObject({ plan: "ENTERPRISE", status: "PAST_DUE" });
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: patchedJson.invoiceId } })).amountCents).toBe(24990);
    const free = await checkoutPost(req("/api/billing/stripe/checkout", "POST", { plan: "FREE" }));
    expect(free.status).toBe(200);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { organizationId: orgB } })).status).toBe("ACTIVE");
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: patchedJson.invoiceId } })).status).toBe("VOID");
    expect(await prisma.auditLog.count({ where: { orgId: orgB, action: "PLAN_CHANGED" } })).toBeGreaterThanOrEqual(3);
  });

  it("gerçek mod: PATCH ve elle ödeme 409, fiyat kimliği yoksa checkout 503", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_placeholder");
    loadEnv({ fresh: true });
    cookieJar.set(SESSION_COOKIE, tokenOwnerB);
    expect((await subscriptionPatch(req("/api/billing/subscription", "PATCH", { plan: "STARTER" }))).status).toBe(409);
    const draft = await prisma.invoice.findFirst({ where: { organizationId: orgB } });
    expect(draft).not.toBeNull();
    expect((await invoicesPost(req("/api/billing/invoices", "POST", { invoiceId: draft!.id, action: "mark-paid" }))).status).toBe(409);
    const checkout = await checkoutPost(req("/api/billing/stripe/checkout", "POST", { plan: "STARTER" }));
    expect(checkout.status).toBe(503);
    expect((await subscriptionGet().then((r) => r.json())).mock).toBe(false);
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    loadEnv({ fresh: true });
  });
});

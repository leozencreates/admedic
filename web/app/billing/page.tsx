"use client";
import { useState, useEffect, useCallback } from "react";
import { api } from "../_lib/client-api";
import { Badge } from "../_components/ui";
import { LanguageSwitcher } from "../_components/language-switcher";
import type { Tone } from "../_components/ui";

const PLAN_TONE: Record<string, Tone> = { FREE: "gray", STARTER: "blue", PROFESSIONAL: "violet", ENTERPRISE: "amber" };
const STATUS_TONE: Record<string, Tone> = { ACTIVE: "green", PAST_DUE: "amber", CANCELED: "red", EXPIRED: "gray" };
const STATUS_LABEL: Record<string, string> = {
  ACTIVE: "Aktif",
  PAST_DUE: "Ödeme bekleniyor",
  CANCELED: "İptal edildi",
  EXPIRED: "Süresi doldu",
};
const INVOICE_STATUS_TONE: Record<string, Tone> = { DRAFT: "gray", PAID: "green", VOID: "red", OVERDUE: "amber" };
const INVOICE_STATUS_LABEL: Record<string, string> = {
  DRAFT: "Taslak",
  PAID: "Ödendi",
  VOID: "İptal",
  OVERDUE: "Gecikmiş",
};

interface SubscriptionData {
  plan: string;
  status: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  stripeManaged: boolean;
}
interface PlanData {
  code: string;
  label: string;
  amountCents: number;
  currency: string;
  interval: string;
}
interface InvoiceData {
  id: string;
  amountCents: number;
  currency: string;
  status: string;
  issuedAt: string;
  dueAt: string;
  paidAt: string | null;
}
interface CheckoutResponse {
  checkoutUrl: string;
  plan: string;
  status: string | null;
  mock: boolean;
  invoiceId?: string | null;
}

function money(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("tr-TR", { style: "currency", currency, minimumFractionDigits: 2 }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}
function day(value: string): string {
  return new Date(value).toLocaleDateString("tr-TR");
}

export default function BillingPage() {
  const [subscription, setSubscription] = useState<SubscriptionData | null>(null);
  const [plans, setPlans] = useState<PlanData[]>([]);
  const [mock, setMock] = useState(false);
  const [invoices, setInvoices] = useState<InvoiceData[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showPlans, setShowPlans] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [subData, invData] = await Promise.all([
        api<{ subscription: SubscriptionData | null; plans: PlanData[]; mock: boolean }>("/api/billing/subscription"),
        api<{ invoices: InvoiceData[] }>("/api/billing/invoices"),
      ]);
      setSubscription(subData.subscription);
      setPlans(subData.plans);
      setMock(subData.mock);
      setInvoices(invData.invoices);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Fatura bilgisi yüklenemedi.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Stripe Checkout dönüşü (?status=paid|cancel): bilgilendirme mesajı.
  useEffect(() => {
    const status = new URLSearchParams(window.location.search).get("status");
    if (status === "paid") setNotice("Ödeme alındı. Abonelik durumu Stripe bildirimiyle birkaç saniye içinde güncellenir.");
    else if (status === "cancel") setNotice("Ödeme iptal edildi; plan değişmedi.");
  }, []);

  async function choosePlan(plan: string) {
    setBusy(true);
    setError("");
    try {
      const result = await api<CheckoutResponse>("/api/billing/stripe/checkout", "POST", { plan });
      if (result.checkoutUrl) {
        window.location.assign(result.checkoutUrl);
        return;
      }
      setShowPlans(false);
      if (result.mock && result.invoiceId) {
        setNotice("Mock mod: plan kaydedildi ve taslak fatura açıldı. Ödemeyi simüle etmek için faturada \"Öde\" düğmesini kullanın.");
      } else {
        setNotice("Plan güncellendi.");
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Plan güncellenemedi.");
    } finally {
      setBusy(false);
    }
  }

  async function payInvoice(invoiceId: string) {
    setBusy(true);
    setError("");
    try {
      await api("/api/billing/invoices", "POST", { invoiceId, action: "mark-paid" });
      setNotice("Fatura ödendi olarak işaretlendi (mock mod).");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ödeme yapılırken hata.");
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <div className="studio-card animate-pulse">Fatura bilgileri yükleniyor…</div>;
  }
  if (error && !subscription && invoices.length === 0) {
    return (
      <div className="space-y-4">
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700" role="alert">{error}</div>
        <button className="primary-button" onClick={() => void load()}>Tekrar Dene</button>
      </div>
    );
  }
  const currentPlan = plans.find((p) => p.code === subscription?.plan);
  const openInvoice = invoices.find((inv) => inv.status === "DRAFT" || inv.status === "OVERDUE");

  return (
    <div className="space-y-6">
      <header className="studio-hero">
        <span className="eyebrow">FATURALANDIRMA</span>
        <h1>Abonelik ve Faturalandırma</h1>
        <div className="mt-4 flex items-center gap-3">
          <span className="text-xs text-slate-400">{mock ? "Ödeme simülasyonu (mock mod)" : "Ödemeler Stripe üzerinden alınır"}</span>
          <LanguageSwitcher />
        </div>
      </header>
      {notice && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800" role="status">{notice}</div>
      )}
      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700" role="alert">{error}</div>
      )}
      <section className="studio-card">
        <div className="section-kicker">ABONELİK</div>
        <h2>Mevcut Plan</h2>
        {subscription ? (
          <>
            <div className="mt-4 flex items-center gap-4">
              <Badge tone={PLAN_TONE[subscription.plan] ?? "gray"}>{currentPlan?.label ?? subscription.plan}</Badge>
              <Badge tone={STATUS_TONE[subscription.status] ?? "gray"}>{STATUS_LABEL[subscription.status] ?? subscription.status}</Badge>
              {currentPlan && currentPlan.amountCents > 0 && (
                <span className="text-sm text-slate-500">{money(currentPlan.amountCents, currentPlan.currency)} / ay</span>
              )}
            </div>
            <div className="mt-4 grid gap-4 md:grid-cols-3">
              <div className="text-sm"><span className="text-slate-500">Dönem başlangıcı:</span> <strong>{day(subscription.currentPeriodStart)}</strong></div>
              <div className="text-sm"><span className="text-slate-500">Dönem sonu:</span> <strong>{day(subscription.currentPeriodEnd)}</strong></div>
              <div className="text-sm"><span className="text-slate-500">İptal:</span> <strong>{subscription.cancelAtPeriodEnd ? "Dönem sonunda" : "Hayır"}</strong></div>
            </div>
            {subscription.status === "PAST_DUE" && openInvoice && (
              <p className="mt-3 text-sm text-amber-700">Abonelik ödeme bekliyor; açık fatura aşağıda listelenmiştir.</p>
            )}
          </>
        ) : (
          <p className="mt-4 text-sm text-slate-500">Henüz abonelik yok. Aşağıdan bir plan seçin.</p>
        )}
        {!showPlans && (
          <button className="mt-4 primary-button" disabled={busy} onClick={() => setShowPlans(true)}>
            {subscription ? "Plan Değiştir" : "Plan Seç"}
          </button>
        )}
        {showPlans && (
          <div className="mt-4 space-y-3">
            <div className="flex flex-wrap gap-3">
              {plans.map((p) => (
                <button
                  key={p.code}
                  className="primary-button"
                  disabled={busy || p.code === subscription?.plan}
                  onClick={() => void choosePlan(p.code)}
                >
                  {p.label}{p.amountCents > 0 ? ` · ${money(p.amountCents, p.currency)}/ay` : " · ücretsiz"}
                </button>
              ))}
              <button className="secondary-button" disabled={busy} onClick={() => setShowPlans(false)}>İptal</button>
            </div>
            <p className="text-xs text-slate-500">
              {mock
                ? "Mock modda ücretli plan seçimi taslak fatura açar; abonelik fatura ödenmeden etkinleşmez."
                : "Ücretli planlar Stripe Checkout sayfasına yönlendirir; abonelik ödeme tamamlanınca etkinleşir."}
            </p>
          </div>
        )}
      </section>
      <section className="studio-card">
        <div className="section-kicker">FATURALAR</div>
        <h2>Geçmiş</h2>
        <div className="mt-4 space-y-2">
          {invoices.length === 0 ? (
            <p className="text-sm text-slate-500">Henüz fatura yok.</p>
          ) : (
            invoices.map((inv) => (
              <div key={inv.id} className="flex items-center gap-4 rounded-lg border border-slate-200 p-3 text-sm">
                <div className="flex-1">
                  <span className="font-medium">#{inv.id.slice(0, 8)}</span>
                  <span className="text-slate-500 ml-3">{day(inv.issuedAt)}</span>
                </div>
                <div className="font-medium">{money(inv.amountCents, inv.currency)}</div>
                <Badge tone={INVOICE_STATUS_TONE[inv.status] ?? "gray"}>{INVOICE_STATUS_LABEL[inv.status] ?? inv.status}</Badge>
                <div>
                  {inv.status === "PAID" ? (
                    <span className="text-xs text-green-600">{inv.paidAt ? day(inv.paidAt) : "Ödendi"}</span>
                  ) : inv.status === "VOID" ? (
                    <span className="text-xs text-slate-400">—</span>
                  ) : mock ? (
                    <button className="primary-button text-xs" disabled={busy} onClick={() => void payInvoice(inv.id)}>Öde (mock)</button>
                  ) : (
                    <span className="text-xs text-slate-500">Stripe üzerinden ödenir</span>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

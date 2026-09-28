"use client";
import { useState, useEffect, useCallback } from "react";
import { api } from "../_lib/client-api";
import { formatDay, formatMoney } from "../_lib/format";
import { Badge, PageHeader } from "../_components/ui";
import type { Tone } from "../_components/ui";

// Renk anlamı (K4-B): yeşil = etkin/tamam · amber = ödeme bekleniyor · gri = kapandı.
const STATUS_TONE: Record<string, Tone> = { ACTIVE: "green", PAST_DUE: "amber", CANCELED: "gray", EXPIRED: "gray" };
const STATUS_LABEL: Record<string, string> = {
  ACTIVE: "Etkin",
  PAST_DUE: "Ödeme bekleniyor",
  CANCELED: "İptal edildi",
  EXPIRED: "Süresi doldu",
};
const INVOICE_STATUS_TONE: Record<string, Tone> = { DRAFT: "gray", PAID: "green", VOID: "gray", OVERDUE: "amber" };
const INVOICE_STATUS_LABEL: Record<string, string> = {
  DRAFT: "Taslak",
  PAID: "Ödendi",
  VOID: "İptal edildi",
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

/** Fatura ve plan tutarları kuruşuyla gösterilir (mali kayıt; yuvarlanmaz). */
function money(cents: number, currency: string): string {
  return formatMoney(cents, currency, { precise: true });
}

export default function BillingPage() {
  const [subscription, setSubscription] = useState<SubscriptionData | null>(null);
  const [plans, setPlans] = useState<PlanData[]>([]);
  const [mock, setMock] = useState(false);
  const [invoices, setInvoices] = useState<InvoiceData[]>([]);
  const [loading, setLoading] = useState(true);
  // Yükleme hatası ile işlem hatası ayrı: işlem hatası sayfayı silmez.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showPlans, setShowPlans] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
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
      setLoadError(e instanceof Error ? e.message : "");
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
    else if (status === "cancel") setNotice("Ödeme tamamlanmadı; plan değişmedi.");
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
        setNotice("Deneme modu: plan kaydedildi ve taslak fatura açıldı. Ödemeyi denemek için faturadaki “Öde (deneme)” düğmesini kullanın.");
      } else {
        setNotice("Plan güncellendi.");
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Plan güncellenemedi. Tekrar deneyin.");
    } finally {
      setBusy(false);
    }
  }

  async function payInvoice(invoiceId: string) {
    setBusy(true);
    setError("");
    try {
      await api("/api/billing/invoices", "POST", { invoiceId, action: "mark-paid" });
      setNotice("Fatura ödendi olarak işaretlendi (deneme modu).");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Fatura ödenemedi. Tekrar deneyin.");
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeader title="Faturalar" crumbs={[{ label: "Ayarlar" }]} />
        <div className="studio-card animate-pulse" role="status">Fatura bilgileri yükleniyor…</div>
      </div>
    );
  }
  if (loadError !== null) {
    return (
      <div className="space-y-4">
        <PageHeader title="Faturalar" crumbs={[{ label: "Ayarlar" }]} />
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800" role="alert">
          <p className="font-medium">Abonelik ve fatura bilgileri yüklenemedi.</p>
          {loadError && <p className="mt-1">{loadError}</p>}
        </div>
        <button type="button" className="primary-button" onClick={() => void load()}>Tekrar dene</button>
      </div>
    );
  }
  const currentPlan = plans.find((p) => p.code === subscription?.plan);
  const openInvoice = invoices.find((inv) => inv.status === "DRAFT" || inv.status === "OVERDUE");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Faturalar"
        description={mock ? "Deneme modu: ödemeler simüle edilir, gerçek ödeme alınmaz." : "Ödemeler Stripe üzerinden alınır."}
        crumbs={[{ label: "Ayarlar" }]}
      />
      {notice && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800" role="status">{notice}</div>
      )}
      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800" role="alert">{error}</div>
      )}
      <section className="studio-card">
        <div className="section-kicker">Abonelik</div>
        <h2>Mevcut plan</h2>
        {subscription ? (
          <>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <span className="text-base font-semibold text-slate-900">{currentPlan?.label ?? "Bilinmeyen plan"}</span>
              <Badge tone={STATUS_TONE[subscription.status] ?? "gray"}>{STATUS_LABEL[subscription.status] ?? "Bilinmeyen durum"}</Badge>
              {currentPlan && currentPlan.amountCents > 0 && (
                <span className="text-sm text-muted">{money(currentPlan.amountCents, currentPlan.currency)} / ay</span>
              )}
            </div>
            <div className="mt-4 grid gap-4 md:grid-cols-3">
              <div className="text-sm"><span className="text-muted">Dönem başlangıcı:</span> <strong>{formatDay(subscription.currentPeriodStart)}</strong></div>
              <div className="text-sm"><span className="text-muted">Dönem sonu:</span> <strong>{formatDay(subscription.currentPeriodEnd)}</strong></div>
              <div className="text-sm">
                <span className="text-muted">Yenileme:</span>{" "}
                <strong>{subscription.cancelAtPeriodEnd ? "Dönem sonunda sona erecek" : "Otomatik yenilenir"}</strong>
              </div>
            </div>
            {subscription.status === "PAST_DUE" && openInvoice && (
              <p className="mt-3 text-sm text-amber-800">Abonelik ödeme bekliyor; açık fatura aşağıda listelenmiştir.</p>
            )}
          </>
        ) : (
          <p className="mt-4 text-sm text-muted">Henüz abonelik yok. Aşağıdan bir plan seçin.</p>
        )}
        {!showPlans && (
          <button type="button" className="mt-4 primary-button" disabled={busy} onClick={() => setShowPlans(true)}>
            {subscription ? "Planı değiştir" : "Plan seç"}
          </button>
        )}
        {showPlans && (
          <div className="mt-4 space-y-3">
            <div className="flex flex-wrap gap-3">
              {plans.map((p) => (
                <button
                  type="button"
                  key={p.code}
                  className="primary-button"
                  disabled={busy || p.code === subscription?.plan}
                  onClick={() => void choosePlan(p.code)}
                >
                  {p.label}{p.amountCents > 0 ? ` · ${money(p.amountCents, p.currency)}/ay` : " · ücretsiz"}
                </button>
              ))}
              <button type="button" className="secondary-button" disabled={busy} onClick={() => setShowPlans(false)}>Vazgeç</button>
            </div>
            <p className="text-xs text-muted">
              {mock
                ? "Deneme modunda ücretli plan seçimi taslak fatura açar; abonelik fatura ödenmeden etkinleşmez."
                : "Ücretli planlar Stripe ödeme sayfasına yönlendirir; abonelik ödeme tamamlanınca etkinleşir."}
            </p>
          </div>
        )}
      </section>
      <section className="studio-card">
        <div className="section-kicker">Faturalar</div>
        <h2>Fatura geçmişi</h2>
        <div className="mt-4 space-y-2">
          {invoices.length === 0 ? (
            <p className="text-sm text-muted">Henüz fatura yok. Ücretli bir plan seçtiğinizde faturalarınız burada listelenir.</p>
          ) : (
            invoices.map((inv) => (
              <div key={inv.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-slate-200 p-3 text-sm">
                <div className="min-w-0 flex-1">
                  <span className="font-medium">Fatura</span>
                  <span className="ml-3 text-muted">{formatDay(inv.issuedAt)}</span>
                </div>
                <div className="font-medium">{money(inv.amountCents, inv.currency)}</div>
                <Badge tone={INVOICE_STATUS_TONE[inv.status] ?? "gray"}>{INVOICE_STATUS_LABEL[inv.status] ?? "Bilinmeyen durum"}</Badge>
                <div>
                  {inv.status === "PAID" ? (
                    <span className="text-xs text-emerald-700">{inv.paidAt ? `Ödeme: ${formatDay(inv.paidAt)}` : "Ödendi"}</span>
                  ) : inv.status === "VOID" ? (
                    <span className="text-xs text-muted">—</span>
                  ) : mock ? (
                    <button type="button" className="primary-button text-xs" disabled={busy} onClick={() => void payInvoice(inv.id)}>Öde (deneme)</button>
                  ) : (
                    <span className="text-xs text-muted">Son ödeme: {formatDay(inv.dueAt)} · Stripe üzerinden ödenir</span>
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

"use client";
import { useState, useEffect } from "react";
import { api } from "../_lib/client-api";
import { Badge, Card, StatCard } from "../_components/ui";
import { LanguageSwitcher } from "../_components/language-switcher";
import type { Tone } from "../_components/ui";
const PLAN_LABEL: Record<string, string> = { FREE: "Ücretsiz", STARTER: "Starter", PROFESSIONAL: "Profesyonel", ENTERPRISE: "Kurumsal" };
const PLAN_TONE: Record<string, Tone> = { FREE: "gray", STARTER: "blue", PROFESSIONAL: "violet", ENTERPRISE: "amber" };
const STATUS_TONE: Record<string, Tone> = { ACTIVE: "green", PAST_DUE: "amber", CANCELED: "red", EXPIRED: "gray" };
const INVOICE_STATUS_TONE: Record<string, Tone> = { DRAFT: "gray", PAID: "green", VOID: "red", OVERDUE: "amber" };
interface SubscriptionData {
  plan: string;
  status: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
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
export default function BillingPage() {
  const [subscription, setSubscription] = useState<SubscriptionData | null>(null);
  const [invoices, setInvoices] = useState<InvoiceData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showUpgrade, setShowUpgrade] = useState(false);
  async function load() {
    setLoading(true);
    setError("");
    try {
      const [subData, invData] = await Promise.all([
        api<{ subscription: SubscriptionData }>("/api/billing/subscription"),
        api<{ invoices: InvoiceData[] }>("/api/billing/invoices"),
      ]);
      setSubscription(subData.subscription);
      setInvoices(invData.invoices);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Fatura bilgisi yüklenemedi.");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, []);
  async function upgradePlan(plan: string) {
    try {
      await api("/api/billing/subscription", "PATCH", { plan });
      setShowUpgrade(false);
      void load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Plan güncellenemedi.");
    }
  }
  async function payInvoice(invoiceId: string) {
    try {
      await api(`/api/billing/invoices/${invoiceId}/pay`, "POST");
      void load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ödeme yapılırken hata.");
    }
  }
  if (loading) {
    return <div className="studio-card animate-pulse">Fatura yükleniyor…</div>;
  }
  if (error) {
    return (
      <div className="space-y-4">
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700" role="alert">{error}</div>
        <button className="primary-button" onClick={load}>Tekrar Dene</button>
      </div>
    );
  }
  return (
    <div className="space-y-6">
      <header className="studio-hero">
        <span className="eyebrow">FATURAJ</span>
        <h1>Abonelik ve Faturalandırma</h1>
        <div className="mt-4 flex items-center gap-3">
          <span className="text-xs text-slate-400">Ödeme ve plan yönetimi</span>
          <LanguageSwitcher />
        </div>
      </header>
      {subscription && (
        <section className="studio-card">
          <div className="section-kicker">ABONELİK</div>
          <h2>Mevcut Plan</h2>
          <div className="mt-4 flex items-center gap-4">
            <Badge tone={PLAN_TONE[subscription.plan] ?? "gray"}>{PLAN_LABEL[subscription.plan] ?? subscription.plan}</Badge>
            <Badge tone={STATUS_TONE[subscription.status] ?? "gray"}>{subscription.status}</Badge>
          </div>
          <div className="mt-4 grid gap-4 md:grid-cols-3">
            <div className="text-sm"><span className="text-slate-500">Döngü Başlangıcı:</span> <strong>{new Date(subscription.currentPeriodStart).toLocaleDateString("tr-TR")}</strong></div>
            <div className="text-sm"><span className="text-slate-500">Döngü Sonu:</span> <strong>{new Date(subscription.currentPeriodEnd).toLocaleDateString("tr-TR")}</strong></div>
            <div className="text-sm"><span className="text-slate-500">İptal:</span> <strong>{subscription.cancelAtPeriodEnd ? "Döngü sonu" : "Hayır"}</strong></div>
          </div>
          {!showUpgrade && (
            <button className="mt-4 primary-button" onClick={() => setShowUpgrade(true)}>Plan Değiştir</button>
          )}
          {showUpgrade && (
            <div className="mt-4 flex flex-wrap gap-3">
              {["FREE", "STARTER", "PROFESSIONAL", "ENTERPRISE"].map((p) => (
                <button key={p} className="primary-button" onClick={() => void upgradePlan(p)}>{PLAN_LABEL[p]}</button>
              ))}
              <button className="secondary-button" onClick={() => setShowUpgrade(false)}>İptar</button>
            </div>
          )}
        </section>
      )}
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
                  <span className="text-slate-500 ml-3">{new Date(inv.issuedAt).toLocaleDateString("tr-TR")}</span>
                </div>
                <div className="font-medium">{(inv.amountCents / 100).toFixed(2)} {inv.currency}</div>
                <Badge tone={INVOICE_STATUS_TONE[inv.status] ?? "gray"}>{inv.status}</Badge>
                <div>
                  {inv.paidAt ? (
                    <span className="text-xs text-green-600">Ödendi</span>
                  ) : (
                    <button className="primary-button text-xs" onClick={() => void payInvoice(inv.id)}>Öde</button>
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

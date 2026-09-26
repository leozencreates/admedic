"use client";
import { useState, useEffect, useCallback } from "react";
import { api } from "../_lib/client-api";
import { Badge, StatCard } from "../_components/ui";
import { LanguageSwitcher } from "../_components/language-switcher";
import type { Tone } from "../_components/ui";
import { formatMoney } from "../_lib/format";
import { alertTypeLabel } from "../_lib/alert-labels";
import { RECOMMENDATION_KIND_LABEL } from "../_lib/recommendation-kinds";

interface InsightSummary {
  totalSpend: number;
  totalImpressions: number;
  totalClicks: number;
  totalPurchases: number;
  totalConvValue: number;
  ctr: number;
  cpmCents: number | null;
  cpcCents: number | null;
  cpaCents: number | null;
  cplCents: number | null;
  roas: number | null;
  totalLeads: number;
  qualifiedLeads: number;
  qualifiedLeadRatio: number;
}
interface InsightDaily {
  date: string;
  spend: number;
  clicks: number;
  leads: number;
  purchases: number;
}
interface InsightCampaign {
  id: string;
  name: string;
  budgetCents: number | null;
  spentCents: number;
  days: number;
  spendPercent: number;
  leadCount: number;
  cplCents: number | null;
}
interface Breakdown { country?: string | null; language?: string; leads: number; qualified: number }
interface InsightAlert {
  id: string;
  type: string;
  severity: string;
  title: string;
  createdAt: string;
}
interface InsightRecommendation {
  id: string;
  type: string;
  title: string;
  description: string;
  priority: string;
  createdAt: string;
}
interface InsightsResponse {
  currency: string;
  insights: {
    period: { from: string; to: string; days: number };
    summary: InsightSummary;
    daily: InsightDaily[];
    campaigns: InsightCampaign[];
    byCountry: Breakdown[];
    byLanguage: Breakdown[];
  };
  alerts: InsightAlert[];
  pendingRecommendations: InsightRecommendation[];
}
const SEVERITY_TONE: Record<string, Tone> = { INFO: "blue", WARNING: "amber", CRITICAL: "red" };
const REFRESH_MS = 30_000;

export default function InsightsPage() {
  const [data, setData] = useState<InsightsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const load = useCallback(async (initial = false) => {
    if (initial) setLoading(true);
    setError("");
    try {
      setData(await api<InsightsResponse>("/api/insights"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "İçgörüler yüklenemedi.");
    } finally {
      if (initial) setLoading(false);
    }
  }, []);
  // İlk yükleme + periyodik yenileme; aralık bileşen kaldırılınca temizlenir.
  useEffect(() => {
    void load(true);
    const interval = setInterval(() => { void load(); }, REFRESH_MS);
    return () => clearInterval(interval);
  }, [load]);

  if (loading) {
    return (
      <div className="space-y-6">
        <header className="studio-hero"><span className="eyebrow">İÇGÖRÜLER</span><h1>Performans Analizi</h1></header>
        <div className="grid gap-6 md:grid-cols-4">{Array.from({ length: 4 }).map((_, i) => (<div key={i} className="h-24 animate-pulse rounded-xl bg-slate-200/60" />))}</div>
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="space-y-4">
        {error && <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700" role="alert">{error}</div>}
        <button className="primary-button" onClick={() => void load(true)}>Tekrar Dene</button>
      </div>
    );
  }
  const { summary, daily, campaigns, byCountry, byLanguage, period } = data.insights;
  const currency = data.currency;
  const money = (cents: number | null | undefined) => formatMoney(cents, currency);
  const maxSpend = Math.max(...daily.map((d) => d.spend), 1);
  return (
    <div className="space-y-6">
      <header className="studio-hero">
        <span className="eyebrow">İÇGÖRÜLER</span>
        <h1>Performans Analizi</h1>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <span className="text-xs text-slate-400">Son {period.days} gün · {currency}</span>
          <a className="secondary-button text-xs" href="/api/reports/weekly?pdf=1">Haftalık rapor (PDF)</a>
          <LanguageSwitcher />
        </div>
      </header>
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-6">
        <StatCard label="Toplam Harcama" value={money(summary.totalSpend)} hint={`${summary.totalPurchases} satın alma${summary.roas !== null ? ` · ROAS ${summary.roas.toFixed(2)}×` : ""}`} tone="violet" />
        <StatCard label="Gösterim" value={summary.totalImpressions.toLocaleString("tr-TR")} hint={`CTR: %${(summary.ctr * 100).toFixed(2)}`} tone="blue" />
        <StatCard label="CPM" value={money(summary.cpmCents)} hint="1000 gösterim maliyeti" tone="blue" />
        <StatCard label="Tıklama" value={summary.totalClicks.toLocaleString("tr-TR")} hint={summary.cpcCents !== null ? `CPC: ${money(summary.cpcCents)}` : undefined} tone="green" />
        <StatCard label="CPL" value={money(summary.cplCents)} hint={`${summary.totalLeads} lead`} tone="amber" />
        <StatCard label="Nitelikli Lead" value={`%${(summary.qualifiedLeadRatio * 100).toFixed(0)}`} hint={`${summary.qualifiedLeads} / ${summary.totalLeads} lead (QUALIFIED ve sonrası)`} tone="red" />
      </div>
      <div className="grid gap-6 md:grid-cols-3">
        <section className="studio-card md:col-span-2">
          <div className="section-kicker">HARCAMA & TIKLAMA</div>
          <h2>Günlük Trend</h2>
          {daily.length === 0 ? (
            <p className="mt-4 text-sm text-slate-500">Bu dönemde insight verisi yok.</p>
          ) : (
            <div className="mt-4 flex h-40 items-end gap-1">
              {daily.map((d) => (
                <div key={d.date} className="flex flex-1 flex-col items-center gap-1" title={`${d.date}: ${money(d.spend)} | ${d.clicks} tıklama | ${d.leads} lead`}>
                  <div className="w-full rounded-t bg-violet-500/70 transition-all hover:bg-violet-500" style={{ height: `${Math.max((d.spend / maxSpend) * 100, 2)}%` }} />
                  <span className="text-[8px] text-slate-400">{d.date.slice(5)}</span>
                </div>
              ))}
            </div>
          )}
          <div className="mt-2 flex gap-4 text-xs text-slate-500">
            <span className="flex items-center gap-1"><span className="w-3 rounded bg-violet-500" /> Harcama</span>
          </div>
        </section>
        <section className="studio-card">
          <div className="section-kicker">KAMPANYA</div>
          <h2>Bütçe Kullanımı</h2>
          <div className="mt-4 space-y-3">
            {campaigns.length === 0 && <p className="text-sm text-slate-500">Aktif kampanya yok.</p>}
            {campaigns.map((c) => (
              <div key={c.id}>
                <div className="flex justify-between text-sm">
                  <span>{c.name}</span>
                  <span className="font-medium">{c.budgetCents !== null ? `%${c.spendPercent}` : "bütçe yok"}</span>
                </div>
                <div className="mt-1 h-2 rounded-full bg-slate-100"><div className="h-2 rounded-full bg-violet-500" style={{ width: `${Math.min(c.spendPercent, 100)}%` }} /></div>
                <div className="mt-1 text-xs text-slate-400">
                  {money(c.spentCents)} harcama{c.budgetCents !== null ? ` · ${money(c.budgetCents)}/gün × ${c.days} gün` : ""} · {c.leadCount} lead{c.cplCents !== null ? ` · CPL ${money(c.cplCents)}` : ""}
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
      <div className="grid gap-6 md:grid-cols-2">
        <section className="studio-card">
          <div className="section-kicker">PAZAR</div>
          <h2>Ülke Kırılımı</h2>
          <BreakdownTable rows={byCountry.map((r) => ({ key: r.country ?? "Belirsiz", leads: r.leads, qualified: r.qualified }))} />
        </section>
        <section className="studio-card">
          <div className="section-kicker">DİL</div>
          <h2>Dil Kırılımı</h2>
          <BreakdownTable rows={byLanguage.map((r) => ({ key: (r.language ?? "").toUpperCase() || "Belirsiz", leads: r.leads, qualified: r.qualified }))} />
        </section>
      </div>
      {data.alerts.length > 0 && (
        <section className="studio-card">
          <div className="section-kicker">UYARI</div>
          <h2>Açık Uyarılar</h2>
          <div className="mt-4 space-y-2">
            {data.alerts.map((a) => (
              <div key={a.id} className="flex items-center gap-3 rounded-lg border border-slate-200 p-3 text-sm">
                <Badge tone={SEVERITY_TONE[a.severity] ?? "gray"}>{a.severity}</Badge>
                <span className="font-medium">{alertTypeLabel(a.type)}</span>
                <span className="text-slate-500">{a.title}</span>
                <span className="ml-auto text-xs text-slate-400">{new Date(a.createdAt).toLocaleDateString("tr-TR")}</span>
              </div>
            ))}
          </div>
          <a className="mt-3 inline-block text-xs text-violet-600" href="/alerts">Tüm uyarılar →</a>
        </section>
      )}
      {data.pendingRecommendations.length > 0 && (
        <section className="studio-card">
          <div className="section-kicker">ÖNERİ</div>
          <h2>Onay Bekleyen Öneriler</h2>
          <div className="mt-4 space-y-2">
            {data.pendingRecommendations.map((r) => (
              <div key={r.id} className="rounded-lg border border-slate-200 p-3 text-sm">
                <div className="flex items-center gap-2">
                  <Badge tone={r.priority === "HIGH" ? "red" : r.priority === "MEDIUM" ? "amber" : "blue"}>{r.priority}</Badge>
                  <span className="font-medium">{r.title}</span>
                  <span className="text-xs text-slate-400">{RECOMMENDATION_KIND_LABEL[r.type] ?? r.type}</span>
                </div>
                <p className="mt-1 text-slate-500">{r.description}</p>
                <span className="mt-1 block text-xs text-slate-400">{new Date(r.createdAt).toLocaleDateString("tr-TR")}</span>
              </div>
            ))}
          </div>
          <a className="mt-3 inline-block text-xs text-violet-600" href="/recommendations">Önerilere git →</a>
        </section>
      )}
    </div>
  );
}

function BreakdownTable({ rows }: { rows: Array<{ key: string; leads: number; qualified: number }> }) {
  if (rows.length === 0) return <p className="mt-4 text-sm text-slate-500">Bu dönemde lead yok.</p>;
  return (
    <table className="mt-4 w-full text-sm">
      <thead className="text-left text-xs text-slate-400">
        <tr><th className="pb-1 font-medium">Kırılım</th><th className="pb-1 text-right font-medium">Lead</th><th className="pb-1 text-right font-medium">Nitelikli</th><th className="pb-1 text-right font-medium">Oran</th></tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} className="border-t border-slate-100">
            <td className="py-1">{r.key}</td>
            <td className="py-1 text-right">{r.leads}</td>
            <td className="py-1 text-right">{r.qualified}</td>
            <td className="py-1 text-right">{r.leads > 0 ? `%${Math.round((r.qualified / r.leads) * 100)}` : "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

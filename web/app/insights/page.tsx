"use client";
import { useState, useEffect } from "react";
import { api } from "../_lib/client-api";
import { Badge, StatCard } from "../_components/ui";
import { LanguageSwitcher } from "../_components/language-switcher";
import type { Tone } from "../_components/ui";
interface InsightSummary {
  totalSpend: number;
  totalImpressions: number;
  totalClicks: number;
  totalPurchases: number;
  totalConvValue: number;
  ctr: number;
  cpc: number | null;
  cpa: number | null;
}
interface InsightDaily {
  date: string;
  spend: number;
  clicks: number;
  purchases: number;
}
interface InsightCampaign {
  id: string;
  name: string;
  budget: number;
  spent: number;
  spendPercent: number;
}
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
const SEVERITY_TONE: Record<string, Tone> = { HIGH: "red", MEDIUM: "amber", LOW: "blue" };
const TYPE_LABEL: Record<string, string> = { CREATIVE_FATIGUE: "Kreatif Yorgunluğu", HIGH_CPL: "Yüksek CPL", LOW_ROAS: "Düşük ROAS", ANOMALY: "Anomali", SCHEDULED: "Zamanlanmış" };
export default function InsightsPage() {
  const [data, setData] = useState<{ insights: { summary: InsightSummary; daily: InsightDaily[]; campaigns: InsightCampaign[] }; alerts: InsightAlert[]; pendingRecommendations: InsightRecommendation[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  async function load() {
    setLoading(true);
    setError("");
    try {
      const d = await api<{ insights: { summary: InsightSummary; daily: InsightDaily[]; campaigns: InsightCampaign[] }; alerts: InsightAlert[]; pendingRecommendations: InsightRecommendation[] }>("/api/insights");
      setData(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Insights yüklenemedi.");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, []);
  const interval = setInterval(() => { void load(); }, 30000);
  useEffect(() => () => clearInterval(interval), []);
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
        <button className="primary-button" onClick={load}>Tekrar Dene</button>
      </div>
    );
  }
  const { summary, daily, campaigns } = data.insights;
  const maxSpend = Math.max(...daily.map((d) => d.spend), 1);
  return (
    <div className="space-y-6">
      <header className="studio-hero">
        <span className="eyebrow">İÇGÖRÜLER</span>
        <h1>Performans Analizi</h1>
        <div className="mt-4 flex items-center gap-3">
          <span className="text-xs text-slate-400">Son 7 gün</span>
          <LanguageSwitcher />
        </div>
      </header>
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Toplam Harcama" value={`${(summary.totalSpend / 100).toFixed(0)} €`} hint={`${summary.totalPurchases} satın alma`} tone="violet" />
        <StatCard label="Gösterim" value={summary.totalImpressions.toLocaleString()} hint={`CTR: ${(summary.ctr * 100).toFixed(2)}%`} tone="blue" />
        <StatCard label="Tıklama" value={summary.totalClicks.toLocaleString()} hint={summary.cpc !== null ? `CPC: €${summary.cpc.toFixed(2)}` : undefined} tone="green" />
        <StatCard label="CPA" value={summary.cpa !== null ? `€${summary.cpa.toFixed(2)}` : "—"} hint={`${summary.totalConvValue / 100} € değer`} tone="amber" />
      </div>
      <div className="grid gap-6 md:grid-cols-3">
        <section className="studio-card md:col-span-2">
          <div className="section-kicker">HARCAMA & TİKLAMA</div>
          <h2>Günlük Trend</h2>
          <div className="mt-4 flex items-end gap-1 h-40">
            {daily.map((d) => (
              <div key={d.date} className="flex-1 flex flex-col items-center gap-1" title={`${d.date}: €${(d.spend / 100).toFixed(0)} | ${d.clicks} tıklama`}>
                <div className="w-full rounded-t bg-violet-500/70 transition-all hover:bg-violet-500" style={{ height: `${Math.max((d.spend / maxSpend) * 100, 2)}%` }} />
                <span className="text-[8px] text-slate-400">{d.date.slice(5)}</span>
              </div>
            ))}
          </div>
          <div className="mt-2 flex gap-4 text-xs text-slate-500">
            <span className="flex items-center gap-1"><span className="w-3 rounded bg-violet-500" /> Harcama</span>
          </div>
        </section>
        <section className="studio-card">
          <div className="section-kicker">KAMPANYA</div>
          <h2>Bütçe Durumu</h2>
          <div className="mt-4 space-y-3">
            {campaigns.map((c) => (
              <div key={c.id}>
                <div className="flex justify-between text-sm"><span>{c.name}</span><span className="font-medium">{c.spendPercent.toFixed(0)}%</span></div>
                <div className="mt-1 h-2 rounded-full bg-slate-100"><div className="h-2 rounded-full bg-violet-500" style={{ width: `${Math.min(c.spendPercent, 100)}%` }} /></div>
              </div>
            ))}
          </div>
        </section>
      </div>
      {data.alerts.length > 0 && (
        <section className="studio-card">
          <div className="section-kicker">UYARI</div>
          <h2>Anomali Uyarıları</h2>
          <div className="mt-4 space-y-2">
            {data.alerts.map((a) => (
              <div key={a.id} className="flex items-center gap-3 rounded-lg border border-slate-200 p-3 text-sm">
                <Badge tone={SEVERITY_TONE[a.severity] ?? "gray"}>{a.severity}</Badge>
                <span className="font-medium">{TYPE_LABEL[a.type] ?? a.type}</span>
                <span className="text-slate-500">{a.title}</span>
                <span className="ml-auto text-xs text-slate-400">{new Date(a.createdAt).toLocaleDateString("tr-TR")}</span>
              </div>
            ))}
          </div>
        </section>
      )}
      {data.pendingRecommendations.length > 0 && (
        <section className="studio-card">
          <div className="section-kicker">ÖNERİ</div>
          <h2>Optimizasyon Önerileri</h2>
          <div className="mt-4 space-y-2">
            {data.pendingRecommendations.map((r) => (
              <div key={r.id} className="rounded-lg border border-slate-200 p-3 text-sm">
                <div className="flex items-center gap-2">
                  <Badge tone={r.priority === "HIGH" ? "red" : r.priority === "MEDIUM" ? "amber" : "blue"}>{r.priority}</Badge>
                  <span className="font-medium">{r.title}</span>
                </div>
                <p className="mt-1 text-slate-500">{r.description}</p>
                <span className="text-xs text-slate-400 mt-1 block">{new Date(r.createdAt).toLocaleDateString("tr-TR")}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

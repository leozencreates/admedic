"use client";
import Link from "next/link";
import { useState, useEffect, useCallback, type CSSProperties, type ReactNode } from "react";
import { api } from "../_lib/client-api";
import { Badge, StatCard } from "../_components/ui";
import {
  formatDate,
  formatDay,
  formatMoney,
  formatNumber,
  formatPercent,
  formatRatio,
  formatRoas,
  formatShortDay,
} from "../_lib/format";
import { countryName, languageName, priorityLabel, severityStyle } from "../_lib/labels";
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
const REFRESH_MS = 30_000;
const DAY_MS = 86_400_000;
/** Eksen etiketi aralığı: en yeni günden geriye her 7. gün. */
const AXIS_EVERY = 7;

/**
 * Dönemin her günü (UTC gün anahtarı) için bir satır: verisi olmayan gün 0 olarak gösterilir,
 * böylece grafik zaman eksenine sadık kalır. Beklenmedik aralıkta API'nin günleri aynen kullanılır.
 */
function fillDays(daily: InsightDaily[], from: string, to: string): InsightDaily[] {
  const start = new Date(from);
  const end = new Date(to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return daily;
  start.setUTCHours(0, 0, 0, 0);
  const span = Math.floor((end.getTime() - start.getTime()) / DAY_MS) + 1;
  if (span < 1 || span > 400) return daily;
  const byDate = new Map(daily.map((d) => [d.date, d]));
  return Array.from({ length: span }, (_, i) => {
    const key = new Date(start.getTime() + i * DAY_MS).toISOString().slice(0, 10);
    return byDate.get(key) ?? { date: key, spend: 0, clicks: 0, leads: 0, purchases: 0 };
  });
}

/** Etiketi çubuğun ortasına hizalar; kenarlardaki etiket kutudan taşmasın diye kenara yaslanır. */
function axisLabelStyle(index: number, count: number): CSSProperties {
  const start = (index / count) * 100;
  const end = ((index + 1) / count) * 100;
  const center = (start + end) / 2;
  if (center < 10) return { left: `${start}%` };
  if (center > 90) return { right: `${100 - end}%` };
  return { left: `${center}%`, transform: "translateX(-50%)" };
}

function DailySpendChart({ daily, days, money }: { daily: InsightDaily[]; days: InsightDaily[]; money: (cents: number) => string }) {
  const maxSpend = Math.max(...days.map((d) => d.spend), 1);
  const count = days.length;
  const peak = daily.reduce((best, d) => (d.spend > best.spend ? d : best), daily[0]);
  const average = Math.round(daily.reduce((sum, d) => sum + d.spend, 0) / daily.length);
  return (
    <>
      {/* Görsel grafik ekran okuyucudan gizlenir; aynı veri aşağıdaki tabloda. */}
      <div className="mt-4" aria-hidden="true">
        <div className="flex h-40 items-end gap-0.5 border-b border-slate-200">
          {days.map((d) => (
            <div
              key={d.date}
              className="flex h-full min-w-0 flex-1 flex-col justify-end"
              title={`${formatShortDay(d.date)}: ${money(d.spend)} · ${formatNumber(d.clicks)} tıklama · ${formatNumber(d.leads)} lead`}
            >
              <div
                className="w-full rounded-t-sm bg-brand/70 transition-colors hover:bg-brand"
                style={{ height: `${d.spend > 0 ? Math.max((d.spend / maxSpend) * 100, 2) : 0}%` }}
              />
            </div>
          ))}
        </div>
        <div className="relative mt-1 h-5">
          {days.map((d, i) =>
            (count - 1 - i) % AXIS_EVERY === 0 ? (
              <span
                key={d.date}
                className="absolute top-0 whitespace-nowrap text-xs text-muted"
                style={axisLabelStyle(i, count)}
              >
                {formatShortDay(d.date)}
              </span>
            ) : null,
          )}
        </div>
      </div>
      <p className="mt-2 text-sm text-slate-600">
        Günlük ortalama {money(average)} · En yüksek gün:{" "}
        <span className="whitespace-nowrap">
          {formatShortDay(peak.date)} ({money(peak.spend)})
        </span>
      </p>
      <table className="sr-only">
        <caption>Günlük harcama, tıklama ve lead</caption>
        <thead>
          <tr>
            <th scope="col">Gün</th>
            <th scope="col">Harcama</th>
            <th scope="col">Tıklama</th>
            <th scope="col">Lead</th>
          </tr>
        </thead>
        <tbody>
          {days.map((d) => (
            <tr key={d.date}>
              <th scope="row">{formatDay(d.date)}</th>
              <td>{money(d.spend)}</td>
              <td>{formatNumber(d.clicks)}</td>
              <td>{formatNumber(d.leads)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function Header({ children }: { children?: ReactNode }) {
  return (
    <header className="studio-hero">
      <span className="eyebrow">İÇGÖRÜLER</span>
      <h1>Performans analizi</h1>
      {children}
    </header>
  );
}

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
      setError(e instanceof Error ? e.message : "İçgörüler yüklenemedi. Sayfayı yenileyip tekrar deneyin.");
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
        <Header />
        <div className="grid gap-6 md:grid-cols-4" role="status" aria-label="İçgörüler yükleniyor">
          {Array.from({ length: 4 }).map((_, i) => (<div key={i} className="h-24 animate-pulse rounded-xl bg-slate-200/60" />))}
        </div>
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="space-y-4">
        <Header />
        {error && <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700" role="alert">{error}</div>}
        <button type="button" className="primary-button" onClick={() => void load(true)}>Tekrar dene</button>
      </div>
    );
  }
  const { summary, daily, campaigns, byCountry, byLanguage, period } = data.insights;
  const currency = data.currency;
  const money = (cents: number | null | undefined) => formatMoney(cents, currency);
  /** Birim maliyetler (CPM, CPC, CPL) iki ondalıklı. */
  const unitMoney = (cents: number | null | undefined) => formatMoney(cents, currency, { precise: true });
  const days = fillDays(daily, period.from, period.to);
  return (
    <div className="space-y-6">
      <Header>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <p>Son {period.days} gün · {currency}</p>
          <a className="secondary-button text-xs" href="/api/reports/weekly?pdf=1">Haftalık rapor (PDF)</a>
        </div>
      </Header>
      {/* 1440 px'te altı sütun değerleri kart kenarına dayıyordu; altı sütun yalnızca çok geniş ekranda. */}
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
        <StatCard
          label="Toplam harcama"
          value={money(summary.totalSpend)}
          hint={`${formatNumber(summary.totalPurchases)} satın alma${summary.roas !== null ? ` · ROAS ${formatRoas(summary.roas)}` : ""}`}
        />
        <StatCard label="Gösterim" value={formatNumber(summary.totalImpressions)} hint={`Tıklama oranı (CTR): ${formatRatio(summary.ctr)}`} />
        <StatCard label="Bin gösterim maliyeti (CPM)" value={unitMoney(summary.cpmCents)} />
        <StatCard
          label="Tıklama"
          value={formatNumber(summary.totalClicks)}
          hint={summary.cpcCents !== null ? `Tıklama başı maliyet (CPC): ${unitMoney(summary.cpcCents)}` : undefined}
        />
        <StatCard label="Lead başı maliyet (CPL)" value={unitMoney(summary.cplCents)} hint={`${formatNumber(summary.totalLeads)} lead`} />
        <StatCard
          label="Nitelikli lead oranı"
          value={formatRatio(summary.qualifiedLeadRatio, 0)}
          hint={`${formatNumber(summary.qualifiedLeads)} / ${formatNumber(summary.totalLeads)} lead (Nitelikli ve sonrası)`}
        />
      </div>
      <div className="grid gap-6 md:grid-cols-3">
        <section className="studio-card min-w-0 md:col-span-2">
          <div className="section-kicker">HARCAMA</div>
          <h2>Günlük trend</h2>
          {daily.length === 0 ? (
            <p className="mt-4 text-sm text-muted">Bu dönemde performans verisi yok.</p>
          ) : (
            <DailySpendChart daily={daily} days={days} money={money} />
          )}
        </section>
        <section className="studio-card min-w-0">
          <div className="section-kicker">KAMPANYA</div>
          <h2>Bütçe kullanımı</h2>
          <div className="mt-4 space-y-3">
            {campaigns.length === 0 && <p className="text-sm text-muted">Etkin kampanya yok.</p>}
            {campaigns.map((c) => (
              <div key={c.id}>
                <div className="flex justify-between gap-3 text-sm">
                  <span className="min-w-0 break-words">{c.name}</span>
                  <span className="shrink-0 font-medium">{c.budgetCents !== null ? formatPercent(c.spendPercent, 0) : "Bütçe yok"}</span>
                </div>
                <div className="mt-1 h-2 rounded-full bg-slate-100" aria-hidden="true">
                  <div className="h-2 rounded-full bg-brand" style={{ width: `${Math.min(c.spendPercent, 100)}%` }} />
                </div>
                <div className="mt-1 text-xs text-muted">
                  {money(c.spentCents)} harcama{c.budgetCents !== null ? ` · ${money(c.budgetCents)}/gün × ${formatNumber(c.days)} gün` : ""} · {formatNumber(c.leadCount)} lead{c.cplCents !== null ? ` · CPL ${unitMoney(c.cplCents)}` : ""}
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
      <div className="grid gap-6 md:grid-cols-2">
        <section className="studio-card min-w-0">
          <div className="section-kicker">PAZAR</div>
          <h2>Ülke kırılımı</h2>
          <BreakdownTable
            heading="Ülke"
            rows={byCountry.map((r) => ({
              key: r.country ?? "",
              label: r.country ? countryName(r.country) : "Belirtilmemiş",
              leads: r.leads,
              qualified: r.qualified,
            }))}
          />
        </section>
        <section className="studio-card min-w-0">
          <div className="section-kicker">DİL</div>
          <h2>Dil kırılımı</h2>
          <BreakdownTable
            heading="Dil"
            rows={byLanguage.map((r) => ({
              key: r.language ?? "",
              label: r.language ? languageName(r.language) : "Belirtilmemiş",
              leads: r.leads,
              qualified: r.qualified,
            }))}
          />
        </section>
      </div>
      {data.alerts.length > 0 && (
        <section className="studio-card">
          <div className="section-kicker">UYARI</div>
          <h2>Açık uyarılar</h2>
          <ul className="mt-4 space-y-2">
            {data.alerts.map((a) => {
              const severity = severityStyle(a.severity);
              return (
                <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-slate-200 p-3 text-sm">
                  <Badge tone={severity.tone}>{severity.label}</Badge>
                  <span className="font-medium">{alertTypeLabel(a.type)}</span>
                  <span className="min-w-0 break-words text-slate-600">{a.title}</span>
                  <span className="ml-auto text-xs text-muted">{formatDate(a.createdAt)}</span>
                </li>
              );
            })}
          </ul>
          <Link className="mt-3 inline-block text-sm font-medium text-brand-strong hover:underline" href="/alerts">Tüm uyarılar →</Link>
        </section>
      )}
      {data.pendingRecommendations.length > 0 && (
        <section className="studio-card">
          <div className="section-kicker">ÖNERİ</div>
          <h2>Onay bekleyen öneriler</h2>
          <ul className="mt-4 space-y-2">
            {data.pendingRecommendations.map((r) => (
              <li key={r.id} className="rounded-lg border border-slate-200 p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="gray">{priorityLabel(r.priority)}</Badge>
                  <span className="font-medium">{r.title}</span>
                  <span className="text-xs text-muted">{RECOMMENDATION_KIND_LABEL[r.type] ?? "Diğer öneri"}</span>
                </div>
                <p className="mt-1 text-slate-600">{r.description}</p>
                <span className="mt-1 block text-xs text-muted">{formatDate(r.createdAt)}</span>
              </li>
            ))}
          </ul>
          <Link className="mt-3 inline-block text-sm font-medium text-brand-strong hover:underline" href="/recommendations">Önerilere git →</Link>
        </section>
      )}
    </div>
  );
}

function BreakdownTable({ heading, rows }: { heading: string; rows: Array<{ key: string; label: string; leads: number; qualified: number }> }) {
  if (rows.length === 0) return <p className="mt-4 text-sm text-muted">Bu dönemde lead yok.</p>;
  return (
    <table className="mt-4 w-full text-sm">
      <thead className="text-left text-xs text-muted">
        <tr>
          <th scope="col" className="pb-1 font-medium">{heading}</th>
          <th scope="col" className="pb-1 text-right font-medium">Lead</th>
          <th scope="col" className="pb-1 text-right font-medium">Nitelikli</th>
          <th scope="col" className="pb-1 text-right font-medium">Oran</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} className="border-t border-slate-100">
            <td className="py-1 pr-2">{r.label}</td>
            <td className="py-1 text-right">{formatNumber(r.leads)}</td>
            <td className="py-1 text-right">{formatNumber(r.qualified)}</td>
            <td className="py-1 text-right">{r.leads > 0 ? formatRatio(r.qualified / r.leads, 0) : "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

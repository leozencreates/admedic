"use client";
import { useEffect, useRef, useState } from "react";
import { Card, SectionHeading } from "../../_components/ui";
import {
  formatDay,
  formatMoney,
  formatNumber,
  formatRatio,
  formatRoas,
  formatShortDay,
} from "../../_lib/format";
import { cpl, ctr, roas, type AdSetRow, type CampaignDetail, type Metrics } from "./types";

const BAR_COLOR = "#5B45D0";
const AXIS_COLOR = "#667085";
const GRID_COLOR = "#EAECF0";
const CHART_HEIGHT = 200;
const PAD = { top: 12, right: 8, bottom: 24, left: 64 };
const DAYS = 30;

/** Son 30 gün (bugün dahil, UTC gün; sunucudaki `sinceDays` ile aynı); verisi olmayan gün 0. */
function last30(daily: CampaignDetail["daily"]): { date: string; spend: number; leads: number; clicks: number; impressions: number }[] {
  const byDate = new Map(daily.map((d) => [d.date, d]));
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: DAYS }, (_, i) => {
    const date = new Date(today - (DAYS - 1 - i) * 86_400_000).toISOString().slice(0, 10);
    const d = byDate.get(date);
    return { date, spend: d?.spend ?? 0, leads: d?.leads ?? 0, clicks: d?.clicks ?? 0, impressions: d?.impressions ?? 0 };
  });
}

function SpendChart({ days, currency }: { days: ReturnType<typeof last30>; currency: string | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const max = Math.max(...days.map((d) => d.spend), 0);
  const total = days.reduce((s, d) => s + d.spend, 0);
  const peak = days.reduce((best, d) => (d.spend > best.spend ? d : best), days[0]);
  const summary =
    `Son ${DAYS} günün günlük harcaması: toplam ${formatMoney(total, currency)}, günlük ortalama ${formatMoney(Math.round(total / DAYS), currency)}` +
    (max > 0 ? `, en yüksek ${formatMoney(peak.spend, currency)} (${formatShortDay(peak.date)}).` : ".");
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = CHART_HEIGHT - PAD.top - PAD.bottom;
  const step = plotW / DAYS;
  const barW = Math.max(2, step * 0.7);
  const ticks = max > 0 ? [0, max / 2, max] : [0];
  const y = (v: number) => PAD.top + plotH - (max > 0 ? (v / max) * plotH : 0);
  const labelIdx = [0, Math.floor((DAYS - 1) / 2), DAYS - 1];

  return (
    <div ref={ref} className="w-full">
      {width > 0 && (
        <svg role="img" aria-label={summary} width={width} height={CHART_HEIGHT} className="block">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} stroke={GRID_COLOR} strokeWidth={1} />
              <text x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize={12} fill={AXIS_COLOR}>
                {formatMoney(Math.round(t), currency)}
              </text>
            </g>
          ))}
          {days.map((d, i) => {
            const top = y(d.spend);
            return (
              <rect
                key={d.date}
                x={PAD.left + i * step + (step - barW) / 2}
                y={top}
                width={barW}
                height={Math.max(0, PAD.top + plotH - top)}
                rx={2}
                fill={BAR_COLOR}
              >
                <title>{`${formatShortDay(d.date)}: ${formatMoney(d.spend, currency)}`}</title>
              </rect>
            );
          })}
          {labelIdx.map((i) => (
            <text
              key={i}
              x={PAD.left + i * step + step / 2}
              y={CHART_HEIGHT - 6}
              textAnchor={i === 0 ? "start" : i === DAYS - 1 ? "end" : "middle"}
              fontSize={12}
              fill={AXIS_COLOR}
            >
              {formatShortDay(days[i].date)}
            </text>
          ))}
        </svg>
      )}
    </div>
  );
}

function Stat({ label, value, week }: { label: string; value: string; week: string }) {
  return (
    <div className="rounded-lg border border-line p-3">
      <p className="text-xs text-ink-3">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums text-ink">{value}</p>
      <p className="mt-1 text-xs tabular-nums text-ink-3">Son 7 gün: {week}</p>
    </div>
  );
}

function statsFor(m: Metrics, currency: string | null) {
  return {
    spend: formatMoney(m.spend, currency),
    leads: formatNumber(m.leads),
    cpl: formatMoney(cpl(m), currency, { precise: true }),
    clicks: formatNumber(m.clicks),
    ctr: formatRatio(ctr(m), 2),
    roas: formatRoas(roas(m)),
  };
}

function AdSetBreakdown({ adSets, currency }: { adSets: AdSetRow[]; currency: string | null }) {
  return (
    <div className="-mx-5 overflow-x-auto px-5" tabIndex={0} role="region" aria-label="Reklam setlerine göre performans tablosu">
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs text-ink-3">
            <th scope="col" className="py-2 pr-3 font-medium">Reklam seti</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Harcama</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Lead</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Lead başı maliyet</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Tıklama</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Tıklama oranı</th>
            <th scope="col" className="py-2 pl-3 text-right font-medium">Reklam getirisi</th>
          </tr>
        </thead>
        <tbody>
          {adSets.map((a) => {
            const s = statsFor(a.metrics30, currency);
            return (
              <tr key={a.id} className="border-b border-line-soft last:border-0">
                <th scope="row" className="py-2 pr-3 text-left font-medium text-ink">{a.name}</th>
                <td className="px-3 py-2 text-right tabular-nums text-ink-2">{s.spend}</td>
                <td className="px-3 py-2 text-right tabular-nums text-ink-2">{s.leads}</td>
                <td className="px-3 py-2 text-right tabular-nums text-ink-2">{s.cpl}</td>
                <td className="px-3 py-2 text-right tabular-nums text-ink-2">{s.clicks}</td>
                <td className="px-3 py-2 text-right tabular-nums text-ink-2">{s.ctr}</td>
                <td className="py-2 pl-3 text-right tabular-nums text-ink-2">{s.roas}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function PerformanceTab({ detail }: { detail: CampaignDetail }) {
  const currency = detail.campaign.currency;
  const { days7, days30 } = detail.metrics;
  const hasData = detail.daily.length > 0 || days30.impressions > 0 || days30.spend > 0;
  if (!hasData) {
    return (
      <Card>
        <p className="text-sm text-ink-2">
          Bu kampanya için henüz performans verisi yok. Kampanya etkinleştirilip Meta&apos;da harcama yapmaya başladığında
          harcama, lead ve tıklama sonuçları burada günlük olarak görünür.
        </p>
      </Card>
    );
  }
  const month = statsFor(days30, currency);
  const week = statsFor(days7, currency);
  const days = last30(detail.daily);
  const withData = detail.adSets.filter((a) => a.metrics30.impressions > 0 || a.metrics30.spend > 0);
  return (
    <div className="space-y-6">
      <Card>
        <SectionHeading title="Son 30 gün" description="Meta'dan okunan günlük veriler; bugünün verisi gün içinde değişebilir." />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
          <Stat label="Harcama" value={month.spend} week={week.spend} />
          <Stat label="Lead" value={month.leads} week={week.leads} />
          <Stat label="Lead başı maliyet" value={month.cpl} week={week.cpl} />
          <Stat label="Tıklama" value={month.clicks} week={week.clicks} />
          <Stat label="Tıklama oranı" value={month.ctr} week={week.ctr} />
          <Stat label="Reklam getirisi" value={month.roas} week={week.roas} />
        </div>
      </Card>
      <Card>
        <SectionHeading title="Günlük harcama" />
        <SpendChart days={days} currency={currency} />
        <details className="mt-3">
          <summary className="cursor-pointer text-sm font-medium text-link">Tablo olarak göster</summary>
          <div className="-mx-5 mt-2 overflow-x-auto px-5" tabIndex={0} role="region" aria-label="Günlük harcama tablosu">
            <table className="w-full min-w-[480px] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-ink-3">
                  <th scope="col" className="py-2 pr-3 font-medium">Gün</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Harcama</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Lead</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Tıklama</th>
                  <th scope="col" className="py-2 pl-3 text-right font-medium">Gösterim</th>
                </tr>
              </thead>
              <tbody>
                {days.map((d) => (
                  <tr key={d.date} className="border-b border-line-soft last:border-0">
                    <th scope="row" className="py-1.5 pr-3 text-left font-normal text-ink">{formatDay(d.date)}</th>
                    <td className="px-3 py-1.5 text-right tabular-nums text-ink-2">{formatMoney(d.spend, currency)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-ink-2">{formatNumber(d.leads)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-ink-2">{formatNumber(d.clicks)}</td>
                    <td className="py-1.5 pl-3 text-right tabular-nums text-ink-2">{formatNumber(d.impressions)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </Card>
      <Card>
        <SectionHeading title="Reklam setlerine göre (30 gün)" />
        {withData.length === 0 ? (
          <p className="text-sm text-ink-3">Veriler kampanya düzeyinde okundu; reklam seti kırılımı yok.</p>
        ) : (
          <AdSetBreakdown adSets={detail.adSets} currency={currency} />
        )}
      </Card>
    </div>
  );
}

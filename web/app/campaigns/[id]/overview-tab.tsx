"use client";
import type { ReactNode } from "react";
import { Badge, Card, EmptyState, SectionHeading } from "../../_components/ui";
import { PLANNER_MARKETS } from "../../_lib/campaign-plan";
import {
  LINK_TEXT,
  MONTH_DAYS,
  dailyBudgetCents,
  languagesText,
  methodName,
  money,
  type CampaignData,
} from "../../_lib/campaign-ui";
import { formatDay, formatMoney, formatNumber } from "../../_lib/format";
import { budgetModeLabel, countryName, entityStatusStyle, policyRiskStyle } from "../../_lib/labels";
import type { AdSetRow } from "./types";

export function marketsText(codes: readonly string[] | undefined): string {
  return codes?.length ? codes.map((m) => PLANNER_MARKETS[m] ?? countryName(m)).join(", ") : "—";
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-ink-3">{label}</dt>
      <dd className="mt-0.5 text-sm text-ink">{children}</dd>
    </div>
  );
}

export function OverviewTab({
  campaign: c,
  adSets,
  onOpenContent,
}: {
  campaign: CampaignData;
  adSets: AdSetRow[];
  onOpenContent: () => void;
}) {
  const plan = c.plan;
  const daily = dailyBudgetCents(c);
  const monthly = daily != null ? daily * MONTH_DAYS : null;
  const reasons = plan?.reasons ?? {};
  const rationale = [
    { label: "Yapı", text: reasons.strategy ?? plan?.rationale },
    { label: "Hedefleme", text: reasons.targeting ?? plan?.targetingRationale },
    { label: "Kampanya hedefi", text: reasons.objective },
    { label: "Dönüşüm yöntemi", text: reasons.conversionMethod },
    { label: "Test planı", text: reasons.testPlan },
  ].filter((r): r is { label: string; text: string } => Boolean(r.text));
  const readiness = c.readiness;
  const needsPrep = readiness && (readiness.reasons.length > 0 || readiness.warnings.length > 0);

  return (
    <div className="space-y-6">
      {needsPrep && (
        <div
          className={`rounded-lg border p-3 text-sm ${readiness.reasons.length ? "border-rose-200 bg-rose-50 text-rose-800" : "border-amber-200 bg-amber-50 text-amber-900"}`}
        >
          <p className="font-medium">
            {readiness.reasons.length ? "Meta'ya yüklemeden önce tamamlanması gerekenler" : "Hazırlık uyarıları"}
          </p>
          <ul className="mt-1 list-inside list-disc text-xs">
            {[...readiness.reasons, ...readiness.warnings].map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <button type="button" onClick={onOpenContent} className={`mt-2 text-xs ${LINK_TEXT}`}>
            İçerik ve görsel sekmesine git
          </button>
        </div>
      )}

      <Card>
        <SectionHeading title="Plan özeti" />
        {plan ? (
          <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
            <Fact label="Bütçe türü">{plan.strategy ? budgetModeLabel(plan.strategy) : "—"}</Fact>
            <Fact label="Dönüşüm yöntemi">{methodName(plan.conversionMethod)}</Fact>
            <Fact label="Pazarlar">{marketsText(plan.markets)}</Fact>
            <Fact label="Diller">{languagesText(plan.languages ?? [])}</Fact>
            <Fact label="Yaş">{plan.ageMin != null && plan.ageMax != null ? `${plan.ageMin}–${plan.ageMax}` : "—"}</Fact>
            <Fact label="Bütçe">
              {daily != null ? `${money(daily, c.currency)}/gün` : "—"}
              {monthly != null && <span className="text-ink-3"> · aylık tahmini {money(monthly, c.currency)}</span>}
            </Fact>
          </dl>
        ) : (
          <div className="space-y-3">
            <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
              <Fact label="Bütçe">
                {daily != null ? `${money(daily, c.currency)}/gün` : "—"}
                {monthly != null && <span className="text-ink-3"> · aylık tahmini {money(monthly, c.currency)}</span>}
              </Fact>
              <Fact label="Reklam setleri">{formatNumber(c.adSets)}</Fact>
              <Fact label="Meta'daki reklamlar">{formatNumber(c.ads)}</Fact>
            </dl>
            <p className="text-xs text-ink-3">Bu kampanya Yeni kampanya ekranından oluşturulmadığı için plan ve ajan gerekçesi yok.</p>
          </div>
        )}
        <p className="mt-4 text-xs text-ink-3">
          {c.policyRisk ? `İçerik kontrolü: ${policyRiskStyle(c.policyRisk).label.toLocaleLowerCase("tr-TR")} · ` : ""}
          Oluşturma: {formatDay(c.createdAt)}
        </p>
      </Card>

      {rationale.length > 0 && (
        <Card>
          <SectionHeading title="Ajanın gerekçesi" />
          <dl className="space-y-3">
            {rationale.map((r) => (
              <div key={r.label}>
                <dt className="text-xs font-medium text-ink-3">{r.label}</dt>
                <dd className="mt-0.5 text-sm text-ink-2">{r.text}</dd>
              </div>
            ))}
          </dl>
        </Card>
      )}

      <Card>
        <SectionHeading title="Reklam setleri" />
        {adSets.length === 0 ? (
          <EmptyState message="Bu kampanyada henüz reklam seti yok. Reklam setleri kampanya Meta'ya yüklendiğinde oluşur." />
        ) : (
          <div className="-mx-5 overflow-x-auto px-5" tabIndex={0} role="region" aria-label="Reklam setleri tablosu">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-ink-3">
                  <th scope="col" className="py-2 pr-3 font-medium">Reklam seti</th>
                  <th scope="col" className="px-3 py-2 font-medium">Durum</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Günlük bütçe</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Reklam</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Harcama (30 gün)</th>
                  <th scope="col" className="py-2 pl-3 text-right font-medium">Lead (30 gün)</th>
                </tr>
              </thead>
              <tbody>
                {adSets.map((a) => {
                  const style = entityStatusStyle(a.status);
                  return (
                    <tr key={a.id} className="border-b border-line-soft last:border-0">
                      <th scope="row" className="py-2 pr-3 text-left font-medium text-ink">{a.name}</th>
                      <td className="px-3 py-2"><Badge tone={style.tone}>{style.label}</Badge></td>
                      <td className="px-3 py-2 text-right tabular-nums text-ink-2">
                        {a.dailyBudget != null ? money(a.dailyBudget, c.currency) : "Kampanya düzeyinde"}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-ink-2">{formatNumber(a.ads)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-ink-2">{formatMoney(a.metrics30.spend, c.currency)}</td>
                      <td className="py-2 pl-3 text-right tabular-nums text-ink-2">{formatNumber(a.metrics30.leads)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

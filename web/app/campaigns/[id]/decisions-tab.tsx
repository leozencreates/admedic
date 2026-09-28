"use client";
import { Badge, Card, SectionHeading } from "../../_components/ui";
import { money } from "../../_lib/campaign-ui";
import { formatDate, formatPercent } from "../../_lib/format";
import { actionStyle, budgetChangeStatusStyle, decisionApprovalStyle, targetTypeLabel } from "../../_lib/labels";
import type { BudgetChangeRow, DecisionRow } from "./types";

/** "Reklam seti · Almanya — AdSet 1"; adı bilinmeyen reklamda yalnızca tür. */
function targetText(type: string, name: string | null): string {
  return name ? `${targetTypeLabel(type)} · ${name}` : targetTypeLabel(type);
}

function budgetText(before: number | null, after: number | null, currency: string | null): string | null {
  if (before == null && after == null) return null;
  return `${money(before, currency)} → ${money(after, currency)}`;
}

export function DecisionsTab({
  decisions,
  budgetChanges,
  currency,
}: {
  decisions: DecisionRow[];
  budgetChanges: BudgetChangeRow[];
  currency: string | null;
}) {
  return (
    <div className="space-y-6">
      <Card>
        <SectionHeading title="Ajan kararları" description="Ajanın bu kampanya, reklam setleri ve reklamları için aldığı son kararlar." />
        {decisions.length === 0 ? (
          <p className="text-sm text-ink-3">
            Ajan bu kampanya için henüz karar almadı. Kampanya yayında veri topladıkça bütçe ve duraklatma kararları burada görünür.
          </p>
        ) : (
          <ul className="divide-y divide-line-soft">
            {decisions.map((d) => {
              const action = actionStyle(d.action);
              const approval = decisionApprovalStyle(d.approval);
              const budget = budgetText(d.budgetBefore, d.budgetAfter, currency);
              return (
                <li key={d.id} className="space-y-1 py-3 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={action.tone}>{action.label}</Badge>
                    <Badge tone={approval.tone}>{approval.label}</Badge>
                    <span className="text-sm font-medium text-ink">{targetText(d.targetType, d.targetName)}</span>
                  </div>
                  {budget && (
                    <p className="text-sm tabular-nums text-ink-2">
                      Bütçe: {budget}
                      {d.changePct != null ? ` (${d.changePct > 0 ? "+" : ""}${formatPercent(d.changePct)})` : ""}
                    </p>
                  )}
                  {d.reason && <p className="text-sm text-ink-2">{d.reason}</p>}
                  <p className="text-xs text-ink-3">
                    <time dateTime={d.createdAt}>{formatDate(d.createdAt)}</time>
                    {d.appliedAt ? (
                      <>
                        {" "}· Uygulandı: <time dateTime={d.appliedAt}>{formatDate(d.appliedAt)}</time>
                      </>
                    ) : null}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      <Card>
        <SectionHeading title="Bütçe değişiklikleri" />
        {budgetChanges.length === 0 ? (
          <p className="text-sm text-ink-3">Bu kampanyada henüz bütçe değişikliği yapılmadı.</p>
        ) : (
          <ul className="divide-y divide-line-soft">
            {budgetChanges.map((b) => {
              const status = budgetChangeStatusStyle(b.status);
              return (
                <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 py-3 first:pt-0 last:pb-0">
                  <div className="min-w-0 space-y-0.5">
                    <p className="text-sm font-medium text-ink">{targetText(b.targetType, b.targetName)}</p>
                    <p className="text-sm tabular-nums text-ink-2">{budgetText(b.fromCents, b.toCents, currency) ?? "—"}</p>
                    <p className="text-xs text-ink-3">
                      <time dateTime={b.createdAt}>{formatDate(b.createdAt)}</time>
                    </p>
                  </div>
                  <Badge tone={status.tone}>{status.label}</Badge>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}

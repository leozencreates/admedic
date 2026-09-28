import { Suspense, type ReactNode } from "react";
import { connection } from "next/server";

import { Badge, Card, EmptyState, PageHeader, SectionHeading, StatCard, Td, Th } from "../_components/ui";
import { getPrimaryWorkspace, prisma } from "../_lib/db";
import { formatDate, formatMoney, formatNumber, formatPercent, formatRoas } from "../_lib/format";
import { actionStyle, decisionApprovalStyle, budgetChangeStatusStyle, targetTypeLabel } from "../_lib/labels";
import { UNKNOWN_TARGET, targetKey, targetNames } from "../_lib/record-refs";

/**
 * Ajan kararları (ADR-0016 · Faz 1 madde 11): ajanın kaydettiği önerilerin salt okunur geçmişi.
 * Bu kararları onaylayan bir kod yolu yoktur (ADR-0002); gerçek onay işleri /approvals'ta.
 */

interface MetricsSnapshot {
  spend?: number;
  revenue?: number;
  purchases?: number;
  roas?: number;
}

/** Bütçe değişikliğinin alanı (`BudgetChange.field`). */
const BUDGET_FIELD_LABEL: Record<string, string> = {
  daily_budget: "Günlük bütçe",
  lifetime_budget: "Toplam bütçe",
};

function Skeleton() {
  return <div className="h-64 animate-pulse rounded-xl bg-slate-200/60" />;
}

/** Klavyeyle odaklanıp kaydırılabilen tablo alanı (mobilde tablo yana kayar). */
function TableRegion({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={label}>
      {children}
    </div>
  );
}

/** Hedefin adı (satır kırılır; reklam adının sonundaki varyant bilgisi kesilmez) ve türü. */
function TargetCell({ name, targetType }: { name: string; targetType: string }) {
  return (
    <Td>
      <span className="block min-w-[160px] max-w-[240px] whitespace-normal break-words font-medium text-slate-900">
        {name}
      </span>
      <span className="block text-xs text-muted">{targetTypeLabel(targetType)}</span>
    </Td>
  );
}

async function ApprovalSummary() {
  await connection();
  const workspace = await getPrimaryWorkspace();
  if (!workspace) return <EmptyState message="Çalışma alanı bulunamadı." />;

  const grouped = await prisma.agentDecision.groupBy({
    by: ["approval"],
    where: { workspaceId: workspace.id },
    _count: { _all: true },
  });
  const counts = new Map(grouped.map((g) => [g.approval, g._count._all]));

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {(["PENDING", "APPROVED", "REJECTED", "NOT_REQUIRED"] as const).map((key) => (
        <StatCard key={key} label={decisionApprovalStyle(key).label} value={formatNumber(counts.get(key) ?? 0)} />
      ))}
    </div>
  );
}

async function Decisions() {
  await connection();
  const workspace = await getPrimaryWorkspace();
  if (!workspace) return null;

  const [decisions, account] = await Promise.all([
    prisma.agentDecision.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { createdAt: "desc" },
      take: 40,
    }),
    prisma.adAccount.findFirst({
      where: { workspaceId: workspace.id, status: "ACTIVE" },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
      select: { currency: true },
    }),
  ]);
  // budgetBefore/After minor unit'tir (agent-engine cent üretir); formatMoney cent bekler.
  const currency = account?.currency || "EUR";
  const names = await targetNames(workspace.id, decisions);
  const money = (cents: number) => formatMoney(cents, currency, { precise: true });

  return (
    <Card>
      <SectionHeading
        title="Karar geçmişi"
        description="Ajanın önerisi, gerekçesi ve onay durumu; en yeni 40 karar."
      />
      {decisions.length === 0 ? (
        <EmptyState message="Henüz ajan kararı yok." />
      ) : (
        <TableRegion label="Karar geçmişi tablosu">
          {/* Her karar kendi tbody'sinde: üst satır değerler, alt satır tam genişlikte gerekçe. */}
          <table className="min-w-full">
            <thead className="border-b border-slate-200">
              <tr>
                <Th>Hedef</Th>
                <Th>Eylem</Th>
                <Th align="right">Değişim</Th>
                <Th align="right">Günlük bütçe</Th>
                <Th align="right">ROAS</Th>
                <Th>Onay</Th>
                <Th>Tarih</Th>
              </tr>
            </thead>
            {decisions.map((d) => {
              const action = actionStyle(d.action);
              const approval = decisionApprovalStyle(d.approval);
              const metrics = (d.metricsSnapshot ?? {}) as MetricsSnapshot;
              return (
                <tbody key={d.id} className="border-b border-slate-100 last:border-b-0">
                  <tr className="align-top">
                    <TargetCell
                      name={names.get(targetKey(d.targetType, d.targetId)) ?? UNKNOWN_TARGET}
                      targetType={d.targetType}
                    />
                    <Td>
                      <Badge tone={action.tone}>{action.label}</Badge>
                    </Td>
                    <Td align="right">
                      {d.changePct == null || d.changePct === 0
                        ? "—"
                        : `${d.changePct > 0 ? "+" : ""}${formatPercent(d.changePct, 0)}`}
                    </Td>
                    <Td align="right">
                      {d.budgetBefore == null
                        ? "—"
                        : d.budgetAfter == null || d.budgetAfter === d.budgetBefore
                          ? money(d.budgetBefore)
                          : `${money(d.budgetBefore)} → ${money(d.budgetAfter)}`}
                    </Td>
                    <Td align="right">{formatRoas(metrics.roas ?? null)}</Td>
                    <Td>
                      <Badge tone={approval.tone}>{approval.label}</Badge>
                    </Td>
                    <Td className="text-muted">{formatDate(d.createdAt)}</Td>
                  </tr>
                  <tr>
                    <td colSpan={7} className="px-3 pb-3 text-sm text-slate-600">
                      {/* Mobilde tablo yana kayarken gerekçe görünür alanda kalır ve ekran genişliğinde kırılır. */}
                      <p className="sticky left-3 max-w-[calc(100vw-6rem)]">
                        <span className="text-muted">Gerekçe:</span> {d.reason}
                      </p>
                    </td>
                  </tr>
                </tbody>
              );
            })}
          </table>
        </TableRegion>
      )}
    </Card>
  );
}

async function BudgetChanges() {
  await connection();
  const workspace = await getPrimaryWorkspace();
  if (!workspace) return null;

  const [changes, account] = await Promise.all([
    prisma.budgetChange.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    prisma.adAccount.findFirst({
      where: { workspaceId: workspace.id, status: "ACTIVE" },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
      select: { currency: true },
    }),
  ]);
  // fromCents/toCents minor unit (şema adı zaten belirtir).
  const currency = account?.currency || "EUR";
  const names = await targetNames(workspace.id, changes);
  const money = (cents: number) => formatMoney(cents, currency, { precise: true });

  return (
    <Card>
      <SectionHeading
        title="Bütçe değişiklikleri"
        description="Meta'ya gönderilen bütçe değişiklikleri ve sonuçları; en yeni 20 kayıt."
      />
      {changes.length === 0 ? (
        <EmptyState message="Henüz bütçe değişikliği yok." />
      ) : (
        <TableRegion label="Bütçe değişiklikleri tablosu">
          <table className="min-w-full divide-y divide-slate-200">
            <thead>
              <tr>
                <Th>Hedef</Th>
                <Th>Alan</Th>
                <Th align="right">Eski</Th>
                <Th align="right">Yeni</Th>
                <Th>Durum</Th>
                <Th>Tarih</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {changes.map((c) => {
                const status = budgetChangeStatusStyle(c.status);
                return (
                  <tr key={c.id}>
                    <TargetCell
                      name={names.get(targetKey(c.targetType, c.targetId)) ?? UNKNOWN_TARGET}
                      targetType={c.targetType}
                    />
                    <Td>{BUDGET_FIELD_LABEL[c.field] ?? "Bütçe"}</Td>
                    <Td align="right">{money(c.fromCents)}</Td>
                    <Td align="right">{money(c.toCents)}</Td>
                    <Td>
                      <Badge tone={status.tone}>{status.label}</Badge>
                    </Td>
                    <Td className="text-muted">{formatDate(c.createdAt)}</Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableRegion>
      )}
    </Card>
  );
}

export default function Page() {
  return (
    <div className="space-y-8">
      <PageHeader
        title="Ajan kararları"
        description="Ajanın kaydettiği öneriler; hiçbiri onayınız olmadan para harcamaz ya da bütçeyi değiştirmez."
        crumbs={[{ label: "Performans" }]}
      />
      <Suspense fallback={<Skeleton />}>
        <ApprovalSummary />
      </Suspense>
      <Suspense fallback={<Skeleton />}>
        <Decisions />
      </Suspense>
      <Suspense fallback={<Skeleton />}>
        <BudgetChanges />
      </Suspense>
    </div>
  );
}

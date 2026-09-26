import { Suspense } from "react";
import { connection } from "next/server";

import { Badge, Card, EmptyState, SectionHeading, StatCard, Td, Th } from "../_components/ui";
import { getPrimaryWorkspace, prisma } from "../_lib/db";
import { formatDate, formatMoney, formatNumber, formatPercent, formatRoas } from "../_lib/format";
import { actionStyle, approvalStyle } from "../_lib/status";

interface MetricsSnapshot {
  spend?: number;
  revenue?: number;
  purchases?: number;
  roas?: number;
}

function Skeleton() {
  return <div className="h-64 animate-pulse rounded-xl bg-slate-200/60" />;
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
      <StatCard
        label="Onay bekleyen"
        value={formatNumber(counts.get("PENDING") ?? 0)}
        hint="Harcama değiştiren aksiyonlar"
      />
      <StatCard label="Onaylanan" value={formatNumber(counts.get("APPROVED") ?? 0)} />
      <StatCard label="Reddedilen" value={formatNumber(counts.get("REJECTED") ?? 0)} />
      <StatCard
        label="Onay gerekmez"
        value={formatNumber(counts.get("NOT_REQUIRED") ?? 0)}
        hint="Yalnızca KEEP kararları"
      />
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
  const adIds = decisions.filter((d) => d.targetType === "AD").map((d) => d.targetId);
  const ads = await prisma.ad.findMany({
    where: { id: { in: adIds } },
    select: { id: true, name: true },
  });
  const adNames = new Map(ads.map((a) => [a.id, a.name]));

  return (
    <Card>
      <SectionHeading
        title="Karar geçmişi"
        description="Ajan önerileri, gerekçeleri ve onay durumu."
      />
      {decisions.length === 0 ? (
        <EmptyState message="Karar yok." />
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200">
            <thead>
              <tr>
                <Th>Hedef</Th>
                <Th>Aksiyon</Th>
                <Th align="right">Değişim</Th>
                <Th align="right">Bütçe</Th>
                <Th align="right">ROAS</Th>
                <Th>Onay</Th>
                <Th>Gerekçe</Th>
                <Th>Tarih</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {decisions.map((d) => {
                const action = actionStyle(d.action);
                const approval = approvalStyle(d.approval);
                const metrics = (d.metricsSnapshot ?? {}) as MetricsSnapshot;
                return (
                  <tr key={d.id}>
                    <Td className="max-w-[200px] truncate font-medium text-slate-900">
                      {adNames.get(d.targetId) ?? d.targetId}
                    </Td>
                    <Td>
                      <Badge tone={action.tone}>{action.label}</Badge>
                    </Td>
                    <Td align="right">
                      {d.changePct == null ? "—" : formatPercent(d.changePct, 0)}
                    </Td>
                    <Td align="right">
                      {d.budgetBefore == null
                        ? "—"
                        : d.budgetAfter == null
                          ? formatMoney(d.budgetBefore, currency)
                          : `${formatMoney(d.budgetBefore, currency)} → ${formatMoney(d.budgetAfter, currency)}`}
                    </Td>
                    <Td align="right">{formatRoas(metrics.roas ?? null)}</Td>
                    <Td>
                      <Badge tone={approval.tone}>{approval.label}</Badge>
                    </Td>
                    <Td className="max-w-[320px] truncate text-slate-500" >{d.reason}</Td>
                    <Td className="text-slate-500">{formatDate(d.createdAt)}</Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
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

  return (
    <Card>
      <SectionHeading
        title="Bütçe değişiklikleri"
        description="Meta'ya uygulanan/uygulanacak değişiklikler (idempotency anahtarlı)."
      />
      {changes.length === 0 ? (
        <EmptyState message="Bütçe değişikliği yok." />
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200">
            <thead>
              <tr>
                <Th>Alan</Th>
                <Th align="right">Eski</Th>
                <Th align="right">Yeni</Th>
                <Th>Durum</Th>
                <Th>Idempotency</Th>
                <Th>Tarih</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {changes.map((c) => (
                <tr key={c.id}>
                  <Td className="font-mono text-xs text-slate-600">{c.field}</Td>
                  <Td align="right">{formatMoney(c.fromCents, currency)}</Td>
                  <Td align="right">{formatMoney(c.toCents, currency)}</Td>
                  <Td>
                    <Badge tone={c.status === "APPLIED" ? "green" : "amber"}>{c.status}</Badge>
                  </Td>
                  <Td className="font-mono text-xs text-slate-500">{c.idempotencyKey}</Td>
                  <Td className="text-slate-500">{formatDate(c.createdAt)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export default function Page() {
  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
          Kararlar & Onaylar
        </h1>
        <p className="text-sm text-slate-500">
          Harcamayı veya reklam durumunu değiştiren her aksiyon insan onayı gerektirir.
        </p>
      </header>
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

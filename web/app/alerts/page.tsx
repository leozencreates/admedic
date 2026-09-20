import { Suspense } from "react";
import { connection } from "next/server";

import { Badge, Card, EmptyState, SectionHeading, StatCard } from "../_components/ui";
import { getPrimaryWorkspace, prisma } from "../_lib/db";
import { formatDate, formatNumber } from "../_lib/format";
import { severityStyle } from "../_lib/status";

function Skeleton() {
  return <div className="h-48 animate-pulse rounded-xl bg-slate-200/60" />;
}

async function AlertSummary() {
  await connection();
  const workspace = await getPrimaryWorkspace();
  if (!workspace) return <EmptyState message="Çalışma alanı bulunamadı." />;

  const [open, critical, warning] = await Promise.all([
    prisma.alert.count({ where: { workspaceId: workspace.id, status: "OPEN" } }),
    prisma.alert.count({
      where: { workspaceId: workspace.id, status: "OPEN", severity: "CRITICAL" },
    }),
    prisma.alert.count({
      where: { workspaceId: workspace.id, status: "OPEN", severity: "WARNING" },
    }),
  ]);

  return (
    <div className="grid grid-cols-3 gap-4">
      <StatCard label="Açık uyarı" value={formatNumber(open)} />
      <StatCard label="Kritik" value={formatNumber(critical)} />
      <StatCard label="Uyarı seviyesi" value={formatNumber(warning)} />
    </div>
  );
}

async function Alerts() {
  await connection();
  const workspace = await getPrimaryWorkspace();
  if (!workspace) return null;

  const alerts = await prisma.alert.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { createdAt: "desc" },
    take: 40,
  });

  return (
    <Card>
      <SectionHeading title="Uyarılar" description="ROAS düşüşü, yüksek CPA, kazanan tespiti." />
      {alerts.length === 0 ? (
        <EmptyState message="Uyarı yok." />
      ) : (
        <ul className="space-y-3">
          {alerts.map((a) => {
            const severity = severityStyle(a.severity);
            return (
              <li key={a.id} className="rounded-lg border border-slate-200 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={severity.tone}>{severity.label}</Badge>
                  <Badge tone={a.status === "OPEN" ? "amber" : "gray"}>
                    {a.status === "OPEN" ? "Açık" : "Çözüldü"}
                  </Badge>
                  <span className="text-xs text-slate-400">{formatDate(a.createdAt)}</span>
                </div>
                <p className="mt-2 text-sm font-medium text-slate-900">{a.title}</p>
                <p className="mt-1 text-sm text-slate-600">{a.message}</p>
                {a.entityType ? (
                  <p className="mt-2 font-mono text-xs text-slate-400">
                    {a.entityType}:{a.entityId ?? "—"}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

export default function Page() {
  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Uyarılar</h1>
        <p className="text-sm text-slate-500">Anomali ve eşik ihlalleri.</p>
      </header>
      <Suspense fallback={<Skeleton />}>
        <AlertSummary />
      </Suspense>
      <Suspense fallback={<Skeleton />}>
        <Alerts />
      </Suspense>
    </div>
  );
}

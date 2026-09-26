import { Suspense } from "react";
import { connection } from "next/server";

import { Badge, Card, EmptyState, SectionHeading, StatCard } from "../_components/ui";
import type { Tone } from "../_components/ui";
import { CARE_ROLES, requirePageActor } from "../_lib/auth";
import { prisma } from "../_lib/db";
import { formatDate, formatNumber } from "../_lib/format";
import { severityStyle } from "../_lib/status";
import { alertStatusLabel, alertTypeLabel } from "../_lib/alert-labels";
import { AlertActions } from "./alert-actions";

const STATUS_TONE: Record<string, Tone> = { OPEN: "amber", ACKED: "blue", RESOLVED: "gray" };

function Skeleton() {
  return <div className="h-48 animate-pulse rounded-xl bg-slate-200/60" />;
}

async function AlertSummary() {
  await connection();
  const actor = await requirePageActor();
  const workspaceId = actor.workspaceId;

  const [open, acked, critical] = await Promise.all([
    prisma.alert.count({ where: { workspaceId, status: "OPEN" } }),
    prisma.alert.count({ where: { workspaceId, status: "ACKED" } }),
    prisma.alert.count({ where: { workspaceId, status: { not: "RESOLVED" }, severity: "CRITICAL" } }),
  ]);

  return (
    <div className="grid grid-cols-3 gap-4">
      <StatCard label="Açık uyarı" value={formatNumber(open)} />
      <StatCard label="Görüldü" value={formatNumber(acked)} />
      <StatCard label="Kritik (çözülmemiş)" value={formatNumber(critical)} />
    </div>
  );
}

async function Alerts() {
  await connection();
  const actor = await requirePageActor();
  const canManage = CARE_ROLES.includes(actor.role);

  const alerts = await prisma.alert.findMany({
    where: { workspaceId: actor.workspaceId },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: 60,
  });

  return (
    <Card>
      <SectionHeading
        title="Uyarılar"
        description="ROAS düşüşü, harcama sıçraması, yüksek CPL, kreatif yorgunluğu ve bağlantı sorunları."
      />
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
                  <Badge tone={STATUS_TONE[a.status] ?? "gray"}>{alertStatusLabel(a.status)}</Badge>
                  <Badge tone="violet">{alertTypeLabel(a.type)}</Badge>
                  <span className="text-xs text-slate-400">{formatDate(a.createdAt)}</span>
                  {a.resolvedAt ? (
                    <span className="text-xs text-slate-400">· Çözüldü: {formatDate(a.resolvedAt)}</span>
                  ) : null}
                </div>
                <p className="mt-2 text-sm font-medium text-slate-900">{a.title}</p>
                <p className="mt-1 text-sm text-slate-600">{a.message}</p>
                {a.entityType ? (
                  <p className="mt-2 font-mono text-xs text-slate-400">
                    {a.entityType}:{a.entityId ?? "—"}
                  </p>
                ) : null}
                {canManage ? <AlertActions id={a.id} status={a.status} /> : null}
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
        <p className="text-sm text-slate-500">Anomali ve eşik ihlalleri; &quot;Görüldü&quot; ile işaretleyin, çözülünce kapatın.</p>
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

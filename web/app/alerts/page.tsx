import { Suspense } from "react";
import Link from "next/link";
import { connection } from "next/server";

import { Badge, Card, EmptyState, PageHeader, SectionHeading, StatCard } from "../_components/ui";
import { CARE_ROLES, requirePageActor } from "../_lib/auth";
import { prisma } from "../_lib/db";
import { formatDate, formatNumber } from "../_lib/format";
import { alertStatusStyle, severityStyle } from "../_lib/labels";
import { alertTypeLabel } from "../_lib/alert-labels";
import { alertRecordLinks } from "../_lib/record-refs";
import { AlertActions } from "./alert-actions";

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
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <StatCard label="Açık uyarı" value={formatNumber(open)} />
      <StatCard label="Görüldü" value={formatNumber(acked)} />
      <StatCard label="Kritik, çözülmemiş" value={formatNumber(critical)} />
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
  // Ham referans (AD:cmuk…) gösterilmez; kayıt bulunursa bağlantı verilir.
  const links = await alertRecordLinks(actor.workspaceId, alerts);

  return (
    <Card>
      <SectionHeading
        title="Uyarılar"
        description="Reklam getirisi (ROAS) düşüşü, beklenmedik harcama artışı, yüksek lead başı maliyet, reklam yorgunluğu ve Meta bağlantı sorunları."
      />
      {alerts.length === 0 ? (
        <EmptyState message="Uyarı yok." />
      ) : (
        <ul className="space-y-3">
          {alerts.map((a) => {
            const severity = severityStyle(a.severity);
            const status = alertStatusStyle(a.status);
            const href = links.get(a.id);
            return (
              <li key={a.id} className="rounded-lg border border-slate-200 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={severity.tone}>{severity.label}</Badge>
                  <Badge tone={status.tone}>{status.label}</Badge>
                  <Badge tone="gray">{alertTypeLabel(a.type)}</Badge>
                  <span className="text-xs text-muted">
                    {formatDate(a.createdAt)}
                    {a.resolvedAt ? ` · Çözüldü: ${formatDate(a.resolvedAt)}` : null}
                  </span>
                </div>
                <p className="mt-2 break-words text-sm font-medium text-slate-900">{a.title}</p>
                <p className="mt-1 break-words text-sm text-slate-600">{a.message}</p>
                {href ? (
                  <Link href={href} className="mt-2 inline-block text-sm font-medium text-brand-strong hover:underline">
                    İlgili kaydı aç<span className="sr-only">: {a.title}</span>
                  </Link>
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
      <PageHeader
        title="Uyarılar"
        description="Performans ve bağlantı sorunları; gördüğünüz uyarıyı işaretleyin, sorun giderilince kapatın."
        crumbs={[{ label: "Performans" }]}
      />
      <Suspense fallback={<Skeleton />}>
        <AlertSummary />
      </Suspense>
      <Suspense fallback={<Skeleton />}>
        <Alerts />
      </Suspense>
    </div>
  );
}

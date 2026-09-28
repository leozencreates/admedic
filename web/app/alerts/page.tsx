import { Suspense } from "react";
import Link from "next/link";
import { connection } from "next/server";

import { Badge, Card, IntroPanel, PageHeader, SectionHeading, StatCard } from "../_components/ui";
import { requirePageActor } from "../_lib/auth";
import { alertScope, canManageAlert } from "../_lib/alert-scope";
import { prisma } from "../_lib/db";
import { formatDate, formatNumber } from "../_lib/format";
import { alertStatusStyle, severityStyle } from "../_lib/labels";
import { alertTypeLabel } from "../_lib/alert-labels";
import { alertRecordLinks } from "../_lib/record-refs";
import { AlertActions } from "./alert-actions";

function Skeleton() {
  return (
    <div role="status" aria-label="Uyarılar yükleniyor" className="h-48 animate-pulse rounded-xl bg-slate-200/60" />
  );
}

async function AlertSummary() {
  await connection();
  const actor = await requirePageActor();
  const scope = alertScope(actor);
  if (!scope) return null;

  const [open, acked, critical] = await Promise.all([
    prisma.alert.count({ where: { ...scope, status: "OPEN" } }),
    prisma.alert.count({ where: { ...scope, status: "ACKED" } }),
    prisma.alert.count({ where: { ...scope, status: { not: "RESOLVED" }, severity: "CRITICAL" } }),
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
  // Zil ve rozetle aynı kapsam (alert-scope.ts): koordinatör yalnızca devir uyarıları, izleyici hiç.
  const scope = alertScope(actor);
  if (!scope)
    return (
      <IntroPanel title="Uyarılar bu rol için kapalı">
        İzleyici rolü performans ve bağlantı uyarılarını görmez. Uyarıları görmeniz gerekiyorsa hesap sahibinden rolünüzü
        değiştirmesini isteyin.
      </IntroPanel>
    );

  const alerts = await prisma.alert.findMany({
    where: scope,
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: 60,
  });
  // Ham referans (AD:cmuk…) gösterilmez; kayıt bulunursa bağlantı verilir.
  const links = await alertRecordLinks(actor.workspaceId, alerts);

  if (alerts.length === 0 && actor.role === "PATIENT_COORDINATOR")
    return (
      <IntroPanel title="Açık devir uyarısı yok">
        Asistan bir konuşmayı size devrettiğinde burada ve zilde uyarı görürsünüz. Konuşmayı Lead&apos;ler sayfasından
        devralıp yanıtlayabilirsiniz.
      </IntroPanel>
    );
  if (alerts.length === 0)
    return (
      <IntroPanel title="Henüz uyarı yok">
        Reklam getirisi (ROAS) düştüğünde, harcama beklenmedik biçimde arttığında, lead başı maliyet yükseldiğinde, reklam
        yorulduğunda ya da Meta bağlantısında sorun çıktığında burada uyarı görürsünüz. Şu an yapmanız gereken bir şey yok.
      </IntroPanel>
    );

  return (
    <Card>
      <SectionHeading
        title="Son uyarılar"
        description="Reklam getirisi (ROAS) düşüşü, beklenmedik harcama artışı, yüksek lead başı maliyet, reklam yorgunluğu ve Meta bağlantı sorunları."
      />
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
              {canManageAlert(actor, a.type) ? <AlertActions id={a.id} status={a.status} title={a.title} /> : null}
            </li>
          );
        })}
      </ul>
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

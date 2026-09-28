import { Suspense, type ReactNode } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { loadEnv } from "@admedic/config";
import { t } from "./_lib/i18n";
import { uiLanguage } from "./_lib/page-meta";

import {
  Badge,
  Card,
  EmptyState,
  PageHeader,
  SectionHeading,
  StatCard,
  Td,
  Th,
} from "./_components/ui";
import { daysAgoUTC, getPrimaryWorkspace, prisma } from "./_lib/db";
import {
  formatDate,
  formatMoney,
  formatNumber,
  formatPercent,
  formatRoas,
} from "./_lib/format";
import { actionStyle, decisionApprovalStyle, severityStyle, targetTypeLabel } from "./_lib/labels";
import { countPendingApprovals, pendingApprovalSummary } from "./_lib/pending-approvals";
import { UNKNOWN_TARGET, alertRecordLinks, targetKey, targetNames } from "./_lib/record-refs";

/** Kök sayfa kök layout ile aynı segmentte olduğundan şablon uygulanmaz; başlık tam yazılır. */
export async function generateMetadata(): Promise<Metadata> {
  return { title: { absolute: `${t("nav.overview", await uiLanguage())} · ${loadEnv().APP_NAME}` } };
}

const SECTION_LINK = "whitespace-nowrap text-sm font-medium text-brand-strong hover:underline";

function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="h-16 animate-pulse rounded-xl bg-slate-200/60"
        />
      ))}
    </div>
  );
}

/** Kartın tamamı bağlantıdır; ızgara hücresini doldurur (komşu kartlarla aynı yükseklik). */
function CardLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="grid rounded-xl transition-shadow hover:shadow-md">
      {children}
    </Link>
  );
}

async function Kpis() {
  await connection();
  const workspace = await getPrimaryWorkspace();
  if (!workspace) {
    return (
      <EmptyState message="Çalışma alanı bulunamadı. Yeniden oturum açın." />
    );
  }

  const since = daysAgoUTC(6);
  const [counts, insightAgg, budgetAgg, pending, openAlerts, policy, account] =
    await Promise.all([
      Promise.all([
        prisma.campaign.count({
          where: { workspaceId: workspace.id, status: "ACTIVE" },
        }),
        prisma.adSet.count({ where: { workspaceId: workspace.id, status: "ACTIVE" } }),
        prisma.ad.count({ where: { workspaceId: workspace.id, status: "ACTIVE" } }),
      ]),
      prisma.insightSnapshot.aggregate({
        where: { workspaceId: workspace.id, date: { gte: since } },
        _sum: {
          spend: true,
          conversionValue: true,
          purchases: true,
          clicks: true,
        },
      }),
      prisma.adSet.aggregate({
        where: { workspaceId: workspace.id, status: "ACTIVE" },
        _sum: { dailyBudget: true },
      }),
      // Gerçek onay işi: içerik, kampanya, etkinleştirme, bütçe önerisi. Ajan kararları onaylanamaz; sayılmaz.
      countPendingApprovals(workspace.id),
      prisma.alert.count({
        where: { workspaceId: workspace.id, status: "OPEN" },
      }),
      prisma.optimizationPolicy.findUnique({
        where: { workspaceId: workspace.id },
      }),
      prisma.adAccount.findFirst({
        where: { workspaceId: workspace.id, status: "ACTIVE" },
        orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
        select: { currency: true },
      }),
    ]);

  const spend = insightAgg._sum.spend ?? 0;
  const revenue = insightAgg._sum.conversionValue ?? 0;
  const purchases = insightAgg._sum.purchases ?? 0;
  const clicks = insightAgg._sum.clicks ?? 0;
  const roas = spend > 0 ? revenue / spend : null;
  const targetRoas = policy?.targetRoas ?? null;
  // Tüm tutarlar minor unit; para birimi varsayılan reklam hesabından (ADR-0011).
  const currency = account?.currency || "EUR";

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
      <CardLink href="/campaigns">
        <StatCard
          label="Etkin kampanya / reklam seti / reklam"
          value={`${formatNumber(counts[0])} / ${formatNumber(counts[1])} / ${formatNumber(counts[2])}`}
          hint={`Günlük planlanan bütçe: ${formatMoney(budgetAgg._sum.dailyBudget, currency)}`}
        />
      </CardLink>
      <StatCard
        label="Son 7 gün harcama"
        value={formatMoney(spend, currency)}
        hint={`${formatNumber(clicks)} tıklama`}
      />
      <StatCard
        label="Son 7 gün ciro"
        value={formatMoney(revenue, currency)}
        hint={`${formatNumber(purchases)} satın alma`}
      />
      <StatCard
        label="Son 7 gün reklam getirisi (ROAS)"
        value={formatRoas(roas)}
        hint={targetRoas ? `Hedef: ${formatRoas(targetRoas)}` : undefined}
      />
      <CardLink href="/approvals">
        <StatCard
          label="Onayınızı bekleyen"
          value={formatNumber(pending.total)}
          hint={pendingApprovalSummary(pending) ?? "Bekleyen iş yok"}
        />
      </CardLink>
      <CardLink href="/alerts">
        <StatCard
          label="Açık uyarı"
          value={formatNumber(openAlerts)}
          hint={openAlerts > 0 ? "İnceleme gerekiyor" : "Açık uyarı yok"}
        />
      </CardLink>
    </div>
  );
}

async function RecentDecisions() {
  await connection();
  const workspace = await getPrimaryWorkspace();
  if (!workspace) return null;

  const decisions = await prisma.agentDecision.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { createdAt: "desc" },
    take: 6,
  });
  const names = await targetNames(workspace.id, decisions);

  return (
    <Card>
      <SectionHeading
        title="Son ajan kararları"
        description="Ajanın kaydettiği öneriler. Hiçbiri onay olmadan harcamayı değiştirmez."
        action={
          <Link href="/decisions" className={SECTION_LINK}>
            Tümünü gör
          </Link>
        }
      />
      {decisions.length === 0 ? (
        <EmptyState message="Henüz ajan kararı yok." />
      ) : (
        <div
          className="overflow-x-auto"
          tabIndex={0}
          role="region"
          aria-label="Son ajan kararları tablosu"
        >
          <table className="min-w-full divide-y divide-slate-200">
            <thead>
              <tr>
                <Th>Hedef</Th>
                <Th>Eylem</Th>
                <Th align="right">Değişim</Th>
                <Th>Onay</Th>
                <Th>Tarih</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {decisions.map((d) => {
                const action = actionStyle(d.action);
                const approval = decisionApprovalStyle(d.approval);
                const name = names.get(targetKey(d.targetType, d.targetId)) ?? UNKNOWN_TARGET;
                return (
                  <tr key={d.id}>
                    <Td>
                      <span className="block min-w-[160px] max-w-[280px] whitespace-normal break-words font-medium text-slate-900">
                        {name}
                      </span>
                      <span className="block text-xs text-muted">{targetTypeLabel(d.targetType)}</span>
                    </Td>
                    <Td>
                      <Badge tone={action.tone}>{action.label}</Badge>
                    </Td>
                    <Td align="right">
                      {d.changePct == null || d.changePct === 0
                        ? "—"
                        : `${d.changePct > 0 ? "+" : ""}${formatPercent(d.changePct, 0)}`}
                    </Td>
                    <Td>
                      <Badge tone={approval.tone}>{approval.label}</Badge>
                    </Td>
                    <Td className="text-muted">
                      {formatDate(d.createdAt)}
                    </Td>
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

async function OpenAlerts() {
  await connection();
  const workspace = await getPrimaryWorkspace();
  if (!workspace) return null;

  const alerts = await prisma.alert.findMany({
    where: { workspaceId: workspace.id, status: "OPEN" },
    orderBy: { createdAt: "desc" },
    take: 5,
  });
  const links = await alertRecordLinks(workspace.id, alerts);

  return (
    <Card>
      <SectionHeading
        title="Açık uyarılar"
        description="Performans, bütçe ve bağlantı sorunları."
        action={
          <Link href="/alerts" className={SECTION_LINK}>
            Tüm uyarılar
          </Link>
        }
      />
      {alerts.length === 0 ? (
        <EmptyState message="Açık uyarı yok." />
      ) : (
        <ul className="space-y-3">
          {alerts.map((a) => {
            const severity = severityStyle(a.severity);
            const href = links.get(a.id);
            return (
              <li key={a.id} className="rounded-lg border border-slate-200 p-3">
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <Badge tone={severity.tone}>{severity.label}</Badge>
                    <p className="min-w-0 break-words text-sm font-medium text-slate-900">{a.title}</p>
                  </div>
                  <span className="text-xs text-muted">
                    {formatDate(a.createdAt)}
                  </span>
                </div>
                <p className="mt-1 break-words text-sm text-slate-600">{a.message}</p>
                {href ? (
                  <Link href={href} className="mt-2 inline-block text-sm font-medium text-brand-strong hover:underline">
                    İlgili kaydı aç<span className="sr-only">: {a.title}</span>
                  </Link>
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
      <PageHeader
        title="Genel bakış"
        description="Çalışma alanınızın son 7 günlük performansı ve ajan durumu."
        actions={
          <Link href="/studio" className="primary-button">
            Reklam oluştur
          </Link>
        }
      />
      <Suspense fallback={<Skeleton rows={2} />}>
        <Kpis />
      </Suspense>
      <Suspense fallback={<Skeleton rows={4} />}>
        <RecentDecisions />
      </Suspense>
      <Suspense fallback={<Skeleton rows={3} />}>
        <OpenAlerts />
      </Suspense>
    </div>
  );
}

import { Suspense } from "react";
import Link from "next/link";
import { connection } from "next/server";

import {
  Badge,
  Card,
  EmptyState,
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
import { actionStyle, approvalStyle } from "./_lib/status";

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

async function Kpis() {
  await connection();
  const workspace = await getPrimaryWorkspace();
  if (!workspace) {
    return (
      <EmptyState message="Çalışma alanı bulunamadı. Yeniden oturum açın." />
    );
  }

  const since = daysAgoUTC(6);
  const [counts, insightAgg, budgetAgg, pending, openAlerts, policy] =
    await Promise.all([
      Promise.all([
        prisma.campaign.count({
          where: { workspaceId: workspace.id, status: "ACTIVE" },
        }),
        prisma.adSet.count({ where: { workspaceId: workspace.id } }),
        prisma.ad.count({ where: { workspaceId: workspace.id } }),
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
      prisma.agentDecision.count({
        where: { workspaceId: workspace.id, approval: "PENDING" },
      }),
      prisma.alert.count({
        where: { workspaceId: workspace.id, status: "OPEN" },
      }),
      prisma.optimizationPolicy.findUnique({
        where: { workspaceId: workspace.id },
      }),
    ]);

  const spend = insightAgg._sum.spend ?? 0;
  const revenue = insightAgg._sum.conversionValue ?? 0;
  const purchases = insightAgg._sum.purchases ?? 0;
  const clicks = insightAgg._sum.clicks ?? 0;
  const roas = spend > 0 ? revenue / spend : null;
  const targetRoas = policy?.targetRoas ?? null;

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
      <StatCard
        label="Aktif kampanya / ad set / ad"
        value={`${formatNumber(counts[0])} / ${formatNumber(counts[1])} / ${formatNumber(counts[2])}`}
        hint={`Günlük planlanan bütçe: ${formatMoney(budgetAgg._sum.dailyBudget)}`}
      />
      <StatCard
        label="Son 7 gün harcama"
        value={formatMoney(spend)}
        hint={`${formatNumber(clicks)} tıklama`}
      />
      <StatCard
        label="Son 7 gün ciro"
        value={formatMoney(revenue)}
        hint={`${formatNumber(purchases)} satın alma`}
      />
      <StatCard
        label="Son 7 gün ROAS"
        value={formatRoas(roas)}
        hint={targetRoas ? `Hedef: ${targetRoas.toFixed(2)}×` : undefined}
      />
      <StatCard
        label="Onay bekleyen karar"
        value={formatNumber(pending)}
        hint={pending > 0 ? "İnsan onayı gerekli" : "Bekleyen yok"}
      />
      <StatCard
        label="Açık uyarı"
        value={formatNumber(openAlerts)}
        hint={openAlerts > 0 ? "İnceleme gerekiyor" : "Açık uyarı yok"}
      />
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
  const adIds = decisions
    .filter((d) => d.targetType === "AD")
    .map((d) => d.targetId);
  const ads = await prisma.ad.findMany({
    where: { id: { in: adIds } },
    select: { id: true, name: true },
  });
  const adNames = new Map(ads.map((a) => [a.id, a.name]));

  return (
    <Card>
      <SectionHeading
        title="Son ajan kararları"
        description="Ajan yalnızca öneri üretir; harcamayı değiştiren aksiyonlar onay bekler."
      />
      {decisions.length === 0 ? (
        <EmptyState message="Henüz karar yok." />
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200">
            <thead>
              <tr>
                <Th>Hedef</Th>
                <Th>Aksiyon</Th>
                <Th align="right">Değişim</Th>
                <Th>Onay</Th>
                <Th>Tarih</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {decisions.map((d) => {
                const action = actionStyle(d.action);
                const approval = approvalStyle(d.approval);
                return (
                  <tr key={d.id}>
                    <Td className="max-w-[280px] truncate font-medium text-slate-900">
                      {adNames.get(d.targetId) ?? d.targetId}
                    </Td>
                    <Td>
                      <Badge tone={action.tone}>{action.label}</Badge>
                    </Td>
                    <Td align="right">
                      {d.changePct == null
                        ? "—"
                        : formatPercent(d.changePct, 0)}
                    </Td>
                    <Td>
                      <Badge tone={approval.tone}>{approval.label}</Badge>
                    </Td>
                    <Td className="text-slate-500">
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

  return (
    <Card>
      <SectionHeading
        title="Açık uyarılar"
        description="Anomali ve eşik ihlalleri."
      />
      {alerts.length === 0 ? (
        <EmptyState message="Açık uyarı yok." />
      ) : (
        <ul className="space-y-3">
          {alerts.map((a) => (
            <li key={a.id} className="rounded-lg border border-slate-200 p-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-medium text-slate-900">{a.title}</p>
                <span className="text-xs text-slate-400">
                  {formatDate(a.createdAt)}
                </span>
              </div>
              <p className="mt-1 text-sm text-slate-600">{a.message}</p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export default function Page() {
  return (
    <div className="space-y-8">
      <header className="studio-hero">
        <span className="eyebrow">BÜYÜME KONTROL MERKEZİ</span>
        <h1>Bir sonraki iyi fikri verilerle bulun.</h1>
        <p className="text-sm text-slate-500">
          Çalışma alanınızın son 7 günlük performansı ve ajan durumu.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link href="/studio" className="primary-button">
            ✦ Reklam oluştur
          </Link>
          <Link href="/experiments" className="secondary-button">
            A/B test merkezi →
          </Link>
        </div>
      </header>
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

import { Suspense } from "react";
import { connection } from "next/server";

import { Badge, Card, EmptyState, SectionHeading, Td, Th } from "../_components/ui";
import { daysAgoUTC, getPrimaryWorkspace, prisma } from "../_lib/db";
import { formatMoney, formatNumber, formatRoas } from "../_lib/format";
import { entityStatusStyle } from "../_lib/status";

function Skeleton() {
  return <div className="h-64 animate-pulse rounded-xl bg-slate-200/60" />;
}

async function Campaigns() {
  await connection();
  const workspace = await getPrimaryWorkspace();
  if (!workspace) return <EmptyState message="Çalışma alanı bulunamadı." />;

  const since = daysAgoUTC(6);
  const [campaigns, grouped, policy] = await Promise.all([
    prisma.campaign.findMany({
      where: { workspaceId: workspace.id },
      include: {
        adAccount: { select: { name: true, currency: true } },
        _count: { select: { adsets: true } },
      },
      orderBy: { name: "asc" },
    }),
    prisma.insightSnapshot.groupBy({
      by: ["campaignId"],
      where: { workspaceId: workspace.id, date: { gte: since }, campaignId: { not: null } },
      _sum: { spend: true, conversionValue: true, purchases: true },
    }),
    prisma.optimizationPolicy.findUnique({ where: { workspaceId: workspace.id } }),
  ]);

  const byCampaign = new Map(grouped.map((g) => [g.campaignId, g._sum]));
  const targetRoas = policy?.targetRoas ?? null;

  return (
    <Card>
      <SectionHeading title="Kampanyalar" description="Son 7 günlük harcama, ciro ve ROAS." />
      {campaigns.length === 0 ? (
        <EmptyState message="Kampanya yok." />
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200">
            <thead>
              <tr>
                <Th>Kampanya</Th>
                <Th>Hesap</Th>
                <Th>Durum</Th>
                <Th align="right">Günlük bütçe</Th>
                <Th align="right">Ad set</Th>
                <Th align="right">7g harcama</Th>
                <Th align="right">7g ciro</Th>
                <Th align="right">Satın alma</Th>
                <Th align="right">ROAS</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {campaigns.map((c) => {
                const sum = byCampaign.get(c.id);
                const spend = sum?.spend ?? 0;
                const revenue = sum?.conversionValue ?? 0;
                const roas = spend > 0 ? revenue / spend : null;
                const status = entityStatusStyle(c.status);
                // Tüm tutarlar minor unit; para birimi reklam hesabından (ADR-0011).
                const currency = c.adAccount.currency || "EUR";
                return (
                  <tr key={c.id}>
                    <Td className="font-medium text-slate-900">{c.name}</Td>
                    <Td className="text-slate-500">
                      {c.adAccount.name} · {currency}
                    </Td>
                    <Td>
                      <Badge tone={status.tone}>{status.label}</Badge>
                    </Td>
                    <Td align="right">{formatMoney(c.dailyBudget, currency)}</Td>
                    <Td align="right">{formatNumber(c._count.adsets)}</Td>
                    <Td align="right">{formatMoney(spend, currency)}</Td>
                    <Td align="right">{formatMoney(revenue, currency)}</Td>
                    <Td align="right">{formatNumber(sum?.purchases ?? 0)}</Td>
                    <Td align="right">
                      <span
                        className={
                          roas != null && targetRoas != null && roas >= targetRoas
                            ? "font-semibold text-emerald-600"
                            : "font-semibold text-slate-700"
                        }
                      >
                        {formatRoas(roas)}
                      </span>
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

async function AdSets() {
  await connection();
  const workspace = await getPrimaryWorkspace();
  if (!workspace) return null;

  const adsets = await prisma.adSet.findMany({
    where: { workspaceId: workspace.id },
    include: {
      campaign: { select: { name: true, adAccount: { select: { currency: true } } } },
      _count: { select: { ads: true } },
    },
    orderBy: [{ campaignId: "asc" }, { name: "asc" }],
  });

  return (
    <Card>
      <SectionHeading
        title="Ad set'ler"
        description="Bütçe ve durum; optimize edilebilir en küçük birim."
      />
      {adsets.length === 0 ? (
        <EmptyState message="Ad set yok." />
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200">
            <thead>
              <tr>
                <Th>Ad set</Th>
                <Th>Kampanya</Th>
                <Th>Durum</Th>
                <Th align="right">Günlük bütçe</Th>
                <Th align="right">Ad</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {adsets.map((a) => {
                const status = entityStatusStyle(a.status);
                return (
                  <tr key={a.id}>
                    <Td className="font-medium text-slate-900">{a.name}</Td>
                    <Td className="text-slate-500">{a.campaign.name}</Td>
                    <Td>
                      <Badge tone={status.tone}>{status.label}</Badge>
                    </Td>
                    <Td align="right">
                      {formatMoney(a.dailyBudget, a.campaign.adAccount.currency || "EUR")}
                    </Td>
                    <Td align="right">{formatNumber(a._count.ads)}</Td>
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

export default function Page() {
  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Kampanyalar</h1>
        <p className="text-sm text-slate-500">Kampanya ve ad set envanteri.</p>
      </header>
      <Suspense fallback={<Skeleton />}>
        <Campaigns />
      </Suspense>
      <Suspense fallback={<Skeleton />}>
        <AdSets />
      </Suspense>
    </div>
  );
}

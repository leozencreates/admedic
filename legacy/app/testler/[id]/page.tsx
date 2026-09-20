import Link from "next/link";
import { notFound } from "next/navigation";
import { getTestDetail } from "@/lib/data";
import { TestActions } from "@/components/TestActions";
import { RoasChart } from "@/components/RoasChart";
import {
  formatTL,
  formatRoas,
  formatNumber,
  formatDateTime,
  formatDate,
  TEST_STATUS_LABEL,
  TEST_STATUS_COLOR,
  ACTION_TYPE_LABEL,
  SEVERITY_COLOR,
} from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function TestDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const test = await getTestDetail(id);
  if (!test) notFound();

  const totalSpend = test.variants.flatMap((v) => v.metrics).reduce((a, m) => a + m.spendKurus, 0);
  const totalRevenue = test.variants.flatMap((v) => v.metrics).reduce((a, m) => a + m.revenueKurus, 0);

  const variants = test.variants.map((v) => {
    const spend = v.metrics.reduce((a, m) => a + m.spendKurus, 0);
    const revenue = v.metrics.reduce((a, m) => a + m.revenueKurus, 0);
    const conversions = v.metrics.reduce((a, m) => a + m.conversions, 0);
    return {
      ...v,
      spend,
      revenue,
      roas: spend > 0 ? revenue / spend : 0,
      conversions,
    };
  });

  const chartSeries = variants.map((v) => ({
    name: v.name,
    points: v.metrics
      .filter((m) => m.date >= test.startedAt)
      .map((m) => ({
        date: m.date.toISOString().slice(0, 10),
        value: m.roas ?? 0,
      })),
  }));

  const winner = variants.find((v) => v.id === test.winningVariantId);
  const maxBudget = Math.max(...variants.map(() => test.campaign.dailyBudgetKurus));

  return (
    <div className="space-y-6">
      <div>
        <Link href="/testler" className="text-xs text-teal-700 hover:underline">
          ← A/B Testleri
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{test.name}</h1>
          <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${TEST_STATUS_COLOR[test.status]}`}>
            {TEST_STATUS_LABEL[test.status]}
          </span>
        </div>
        <p className="text-sm text-zinc-500">
          {test.campaign.name} · {formatDate(test.startedAt)}
          {test.endedAt ? ` → ${formatDate(test.endedAt)}` : ""}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div className="rounded-xl border border-zinc-200 bg-white p-4">
          <p className="text-xs font-medium uppercase text-zinc-500">Toplam Harcama</p>
          <p className="mt-1 text-xl font-bold">{formatTL(totalSpend)}</p>
        </div>
        <div className="rounded-xl border border-zinc-200 bg-white p-4">
          <p className="text-xs font-medium uppercase text-zinc-500">Toplam Gelir</p>
          <p className="mt-1 text-xl font-bold">{formatTL(totalRevenue)}</p>
        </div>
        <div className="rounded-xl border border-zinc-200 bg-white p-4">
          <p className="text-xs font-medium uppercase text-zinc-500">ROAS</p>
          <p className="mt-1 text-xl font-bold text-teal-700">{formatRoas(totalSpend > 0 ? totalRevenue / totalSpend : 0)}</p>
        </div>
        <div className="rounded-xl border border-zinc-200 bg-white p-4">
          <p className="text-xs font-medium uppercase text-zinc-500">Kazanan</p>
          <p className="mt-1 truncate text-sm font-semibold">
            {winner?.name ?? "—"}
          </p>
        </div>
      </div>

      <TestActions testId={test.id} status={test.status} />

      <div className="rounded-xl border border-zinc-200 bg-white p-4">
        <h2 className="mb-4 font-medium">Günlük ROAS Karşılaştırması</h2>
        <RoasChart series={chartSeries} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {variants.map((v) => (
          <div
            key={v.id}
            className={`rounded-xl border bg-white p-4 ${v.id === test.winningVariantId ? "border-emerald-300 ring-1 ring-emerald-200" : "border-zinc-200"}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-medium">{v.name}</p>
                <p className="text-xs text-zinc-500">{v.metaAdSetId ?? "yerel varyant"}</p>
              </div>
              {v.id === test.winningVariantId && (
                <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">
                  Kazanan
                </span>
              )}
            </div>

            <div className="mt-4 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              <div>
                <p className="text-xs text-zinc-500">ROAS</p>
                <p className="font-semibold text-teal-700">{formatRoas(v.roas)}</p>
              </div>
              <div>
                <p className="text-xs text-zinc-500">Dönüşüm</p>
                <p className="font-semibold">{formatNumber(v.conversions)}</p>
              </div>
              <div>
                <p className="text-xs text-zinc-500">Harcama</p>
                <p className="font-semibold">{formatTL(v.spend)}</p>
              </div>
              <div>
                <p className="text-xs text-zinc-500">Gelir</p>
                <p className="font-semibold">{formatTL(v.revenue)}</p>
              </div>
            </div>

            <div className="mt-4">
              <div className="flex items-center justify-between text-xs text-zinc-500">
                <span>Bütçe</span>
                <span>
                  {formatTL(v.budgetKurus)} / {formatTL(test.campaign.dailyBudgetKurus)}
                </span>
              </div>
              <div className="mt-1 h-2 overflow-hidden rounded-full bg-zinc-100">
                <div
                  className="h-full rounded-full bg-teal-600"
                  style={{ width: `${Math.min((v.budgetKurus / Math.max(maxBudget, 1)) * 100, 100)}%` }}
                />
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-zinc-200 bg-white">
        <div className="border-b border-zinc-100 px-4 py-3 font-medium">
          Agent Karar Günlüğü
        </div>
        {test.actions.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-zinc-500">Henüz aksiyon yok.</p>
        ) : (
          <ul className="divide-y divide-zinc-100">
            {test.actions.map((a) => (
              <li key={a.id} className="flex gap-3 px-4 py-3">
                <span className={`mt-1 h-2 w-2 shrink-0 rounded-full border-2 ${SEVERITY_COLOR[a.severity] ?? "border-zinc-300"}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-medium">
                      {ACTION_TYPE_LABEL[a.type] ?? a.type}
                    </p>
                    <span className="text-xs text-zinc-400">{formatDateTime(a.createdAt)}</span>
                  </div>
                  <p className="mt-0.5 text-sm text-zinc-600">{a.detail}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
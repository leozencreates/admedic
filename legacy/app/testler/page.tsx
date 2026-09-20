import Link from "next/link";
import { getTests } from "@/lib/data";
import {
  formatTL,
  formatRoas,
  formatDate,
  formatDateTime,
  TEST_STATUS_LABEL,
  TEST_STATUS_COLOR,
  ACTION_TYPE_LABEL,
} from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function TestlerPage() {
  const tests = await getTests();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">A/B Testleri</h1>
          <p className="text-sm text-zinc-500">
            Agent&apos;ın yönettiği testler ve karar günlüğü
          </p>
        </div>
        <Link
          href="/testler/yeni"
          className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-medium text-white hover:bg-teal-700"
        >
          + Yeni A/B Testi
        </Link>
      </div>

      {tests.length === 0 ? (
        <p className="rounded-xl border border-zinc-200 bg-white px-4 py-10 text-center text-sm text-zinc-500">
          Henüz test yok.
        </p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {tests.map((t) => (
            <Link
              key={t.id}
              href={`/testler/${t.id}`}
              className="rounded-xl border border-zinc-200 bg-white p-4 hover:shadow-sm"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-medium">{t.name}</p>
                  <p className="text-xs text-zinc-500">
                    {t.campaignName} · {t.variantCount} varyant ·{" "}
                    {formatDate(t.startedAt)}
                  </p>
                </div>
                <span
                  className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${TEST_STATUS_COLOR[t.status]}`}
                >
                  {TEST_STATUS_LABEL[t.status]}
                </span>
              </div>

              <div className="mt-4 grid grid-cols-3 gap-2 border-t border-zinc-100 pt-3">
                <div>
                  <p className="text-xs text-zinc-500">Harcama</p>
                  <p className="text-sm font-semibold">
                    {formatTL(t.totalSpendKurus)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-zinc-500">Gelir</p>
                  <p className="text-sm font-semibold">
                    {formatTL(t.totalRevenueKurus)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-zinc-500">ROAS</p>
                  <p className="text-sm font-semibold text-teal-700">
                    {formatRoas(t.roas)}
                  </p>
                </div>
              </div>

              {t.winnerName && (
                <p className="mt-3 truncate rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
                  Kazanan: {t.winnerName}
                </p>
              )}

              {t.lastAction && (
                <p className="mt-2 text-xs text-zinc-500">
                  {ACTION_TYPE_LABEL[t.lastAction.type] ?? t.lastAction.type} ·{" "}
                  {formatDateTime(t.lastAction.createdAt)}
                </p>
              )}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
import Link from "next/link";
import { getDashboard } from "@/lib/data";
import {
  formatTL,
  formatRoas,
  formatNumber,
  formatDate,
  TEST_STATUS_LABEL,
  TEST_STATUS_COLOR,
} from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const data = await getDashboard();

  const cards = [
    { label: "Toplam Harcama", value: formatTL(data.totalSpendKurus) },
    { label: "Toplam Gelir", value: formatTL(data.totalRevenueKurus) },
    { label: "Ortalama ROAS", value: formatRoas(data.roas) },
    { label: "Toplam Dönüşüm", value: formatNumber(data.totalConversions) },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Genel Bakış</h1>
          <p className="text-sm text-zinc-500">
            {data.clinic.name} — reklam performansı özeti
          </p>
        </div>
        <Link
          href="/testler/yeni"
          className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-medium text-white hover:bg-teal-700"
        >
          + Yeni A/B Testi
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {cards.map((c) => (
          <div
            key={c.label}
            className="rounded-xl border border-zinc-200 bg-white p-4"
          >
            <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
              {c.label}
            </p>
            <p className="mt-1 text-2xl font-bold">{c.value}</p>
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-zinc-200 bg-white">
        <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-3">
          <h2 className="font-medium">A/B Testleri</h2>
          <div className="flex gap-3 text-xs text-zinc-500">
            <span>
              <span className="mr-1 inline-block h-2 w-2 rounded-full bg-emerald-500" />
              {data.runningCount} çalışıyor
            </span>
            <span>
              <span className="mr-1 inline-block h-2 w-2 rounded-full bg-blue-500" />
              {data.finishedCount} tamamlandı
            </span>
          </div>
        </div>

        {data.tests.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-zinc-500">
            Henüz test yok. İlk A/B testini oluştur.
          </p>
        ) : (
          <ul className="divide-y divide-zinc-100">
            {data.tests.map((t) => (
              <li key={t.id}>
                <Link
                  href={`/testler/${t.id}`}
                  className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-zinc-50"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium">{t.name}</p>
                    <p className="text-xs text-zinc-500">
                      {t.campaignName} · {t.variantCount} varyant ·{" "}
                      {formatDate(t.startedAt)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3 text-sm">
                    {t.winnerName && (
                      <span className="hidden max-w-[180px] truncate text-xs text-emerald-700 md:block">
                        {t.winnerName}
                      </span>
                    )}
                    <span
                      className={`rounded-full px-2.5 py-1 text-xs font-medium ${TEST_STATUS_COLOR[t.status]}`}
                    >
                      {TEST_STATUS_LABEL[t.status]}
                    </span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
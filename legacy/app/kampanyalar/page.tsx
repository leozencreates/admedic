import Link from "next/link";
import { getCampaigns } from "@/lib/data";
import { formatTL } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function KampanyalarPage() {
  const { metaConnected, campaigns } = await getCampaigns();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Kampanyalar</h1>
          <p className="text-sm text-zinc-500">
            Meta kampanyaları ve A/B test durumları
          </p>
        </div>
        <Link
          href="/testler/yeni"
          className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-medium text-white hover:bg-teal-700"
        >
          + Yeni A/B Testi
        </Link>
      </div>

      {!metaConnected && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Meta hesabı şu an bağlı değil — demo modundasınız. Canlı veri için{" "}
          <Link href="/meta" className="font-semibold underline">
            Meta Bağlantısı
          </Link>{" "}
          sayfasından bağlayın.
        </div>
      )}

      {campaigns.length === 0 ? (
        <p className="rounded-xl border border-zinc-200 bg-white px-4 py-8 text-center text-sm text-zinc-500">
          Kampanya bulunamadı. Önce Meta hesabını bağla ve senkronize et.
        </p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-zinc-100 bg-zinc-50 text-xs uppercase text-zinc-500">
              <tr>
                <th className="px-4 py-3">Kampanya</th>
                <th className="px-4 py-3">Durum</th>
                <th className="px-4 py-3">Günlük Bütçe</th>
                <th className="px-4 py-3">Çalışan Test</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {campaigns.map((c) => (
                <tr key={c.id} className="hover:bg-zinc-50">
                  <td className="px-4 py-3">
                    <p className="font-medium">{c.name}</p>
                    <p className="text-xs text-zinc-500">{c.metaCampaignId}</p>
                  </td>
                  <td className="px-4 py-3">
                    <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs">
                      {c.status}
                    </span>
                  </td>
                  <td className="px-4 py-3">{formatTL(c.dailyBudgetKurus)}</td>
                  <td className="px-4 py-3">
                    {c.runningTestCount > 0 ? (
                      <span className="text-emerald-700">
                        {c.runningTestCount} test
                      </span>
                    ) : (
                      <span className="text-zinc-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/testler/yeni?kampanya=${c.id}`}
                      className="text-teal-700 hover:underline"
                    >
                      Test aç
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
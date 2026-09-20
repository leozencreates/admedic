import Link from "next/link";
import { getCurrentClinic } from "@/lib/clinic";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export default async function MetaPage({
  searchParams,
}: {
  searchParams: Promise<{ bagli?: string }>;
}) {
  const sp = await searchParams;
  const clinic = await getCurrentClinic();
  const accounts = await prisma.metaAccount.findMany({
    where: { clinicId: clinic.id },
  });
  const connected = accounts.some((a) => !!a.accessToken);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Meta Bağlantısı</h1>
        <p className="text-sm text-zinc-500">
          Reklam hesabını bağlayın; kampanyalar ve A/B testleri canlı veriyle
          çalışsın.
        </p>
      </div>

      {sp.bagli === "1" && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          Meta hesabı başarıyla bağlandı. Şimdi kampanyaları senkronize edin.
        </div>
      )}

      <div className="rounded-xl border border-zinc-200 bg-white p-6">
        <p className="mb-3 text-sm text-zinc-600">
          Durum:{" "}
          {connected ? (
            <span className="font-medium text-emerald-700">Bağlı</span>
          ) : (
            <span className="font-medium text-amber-700">Bağlı değil</span>
          )}
        </p>

        <button
          type="button"
          onClick={async () => {
            const res = await fetch("/api/meta/connect");
            const d = await res.json();
            if (d.url) window.location.href = d.url;
            else alert(d.error ?? "Bağlantı URL'si alınamadı");
          }}
          className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700"
        >
          Meta ile Bağla (OAuth)
        </button>

        <p className="mt-3 text-xs text-zinc-500">
          Gereksinimler (yönetici):{" "}
          <code className="rounded bg-zinc-100 px-1">
            META_APP_ID, META_APP_SECRET, META_REDIRECT_URI
          </code>{" "}
          .env içinde tanımlı olmalı.
        </p>
      </div>

      <div className="rounded-xl border border-zinc-200 bg-white p-6">
        <h2 className="mb-3 font-medium">Bağlı Reklam Hesapları</h2>
        {accounts.length === 0 ? (
          <p className="text-sm text-zinc-500">Henüz hesap yok.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {accounts.map((a) => (
              <li key={a.id} className="flex justify-between rounded-lg bg-zinc-50 px-3 py-2">
                <span className="font-mono">{a.adAccountId}</span>
                <span className="text-zinc-500">{a.active ? "aktif" : "pasif"}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4">
          <button
            type="button"
            onClick={async () => {
              const res = await fetch("/api/meta/sync", { method: "POST" });
              const d = await res.json();
              alert(d.message ?? d.error ?? "Senkronize edildi");
            }}
            className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Kampanyaları Senkronize Et
          </button>
        </div>
      </div>

      <p className="text-xs text-zinc-500">
        WhatsApp entegrasyon ayarları için{" "}
        <Link href="/whatsapp" className="text-teal-700 underline">
          WhatsApp sayfası
        </Link>
        .
      </p>
    </div>
  );
}
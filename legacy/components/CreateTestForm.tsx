"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

interface CampaignOption {
  id: string;
  name: string;
  dailyBudgetKurus: number;
  usedAdSetIds: (string | null)[];
}

interface AdSetOption {
  metaAdSetId: string;
  name: string;
}

export function CreateTestForm({ initialCampaignId }: { initialCampaignId?: string }) {
  const router = useRouter();
  const [campaigns, setCampaigns] = useState<CampaignOption[]>([]);
  const [adSetOptions, setAdSetOptions] = useState<AdSetOption[]>([]);
  const [campaignId, setCampaignId] = useState(initialCampaignId ?? "");
  const [name, setName] = useState("");
  const [significance, setSignificance] = useState("0.95");
  const [minSpendTL, setMinSpendTL] = useState("1000");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    fetch("/api/campaigns")
      .then((r) => r.json())
      .then((d) => setCampaigns(d.campaigns ?? []))
      .catch(() => setError("Kampanyalar yüklenemedi."));
  }, []);

  async function fetchAdSets(cId: string) {
    if (!cId) return;
    try {
      // Meta bağlıysa ad setleri senkron servisinden gelebilir;
      // demo modda yerel olarak işaretli ad setlerini listelemiyoruz.
      const res = await fetch("/api/meta/sync", { method: "POST" });
      const d = await res.json();
      if (d.demo) {
        setAdSetOptions([]);
      }
    } catch {
      setAdSetOptions([]);
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!campaignId) {
      setError("Lütfen bir kampanya seç.");
      return;
    }
    const payload = {
      campaignId,
      name,
      significanceLevel: Number(significance),
      minSpendKurusPerVariant: Math.round(Number(minSpendTL) * 100),
      adSets: adSetOptions.length ? adSetOptions : undefined,
    };
    try {
      const res = await fetch("/api/tests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "Test oluşturulamadı.");
      startTransition(() => router.push(`/testler/${d.test.id}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Bilinmeyen hata");
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="mx-auto max-w-2xl space-y-5 rounded-xl border border-zinc-200 bg-white p-6"
    >
      <div>
        <label className="mb-1 block text-sm font-medium">Test Adı</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          placeholder="örn. Görsel A vs Görsel B — ROAS testi"
          className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
        />
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium">Kampanya</label>
        <select
          value={campaignId}
          onChange={(e) => {
            setCampaignId(e.target.value);
            fetchAdSets(e.target.value);
          }}
          required
          className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
        >
          <option value="">Kampanya seçin…</option>
          {campaigns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="mb-1 block text-sm font-medium">
            Gerekli Önem Düzeyi
          </label>
          <select
            value={significance}
            onChange={(e) => setSignificance(e.target.value)}
            className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
          >
            <option value="0.90">%90 (daha hızlı karar)</option>
            <option value="0.95">%95 (önerilen)</option>
            <option value="0.98">%98 (daha güvenli)</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium">
            Min. Harcama (TL) / varyant
          </label>
          <input
            type="number"
            min={100}
            step={100}
            value={minSpendTL}
            onChange={(e) => setMinSpendTL(e.target.value)}
            className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
          />
        </div>
      </div>

      {adSetOptions.length > 0 && (
        <div>
          <label className="mb-1 block text-sm font-medium">Ad Setleri</label>
          <p className="mb-2 text-xs text-zinc-500">
            Seçilmezse Meta kampanyasında otomatik 2 varyant açılır.
          </p>
        </div>
      )}

      {error && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <div className="flex justify-end gap-3">
        <button
          type="button"
          onClick={() => router.back()}
          className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-50"
        >
          Vazgeç
        </button>
        <button
          type="submit"
          disabled={isPending}
          className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-medium text-white hover:bg-teal-700 disabled:opacity-50"
        >
          {isPending ? "Oluşturuluyor…" : "Testi Başlat"}
        </button>
      </div>
    </form>
  );
}
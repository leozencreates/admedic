"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function LeadAgentBar() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function run(dryRun: boolean) {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/agent/followups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "Hata");
      const lines = d.sent.map(
        (s: { leadName: string; type: string; mock?: boolean }) =>
          `${s.type}: ${s.leadName}${s.mock ? " (simülasyon)" : ""}`
      );
      setResult(
        `Planlanan: ${d.planned.length}, Gönderilen: ${d.sent.length}, Hata: ${d.failed.length}` +
          (lines.length ? `\n${lines.join("\n")}` : "") +
          (d.dryRun ? "\n[dry-run: hiçbir mesaj gönderilmedi]" : "")
      );
      router.refresh();
    } catch (e) {
      setResult(e instanceof Error ? e.message : "Bilinmeyen hata");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">Otomatik Takip Agentı</p>
          <p className="text-xs text-zinc-500">
            Karşılama mesajı, günlük hatırlatma ve klinik medyası paylaşımını
            planlar ve gönderir.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => run(true)}
            disabled={busy}
            className="rounded-lg border border-zinc-300 px-3 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
          >
            {busy ? "Çalışıyor…" : "Önizle (dry-run)"}
          </button>
          <button
            onClick={() => run(false)}
            disabled={busy}
            className="rounded-lg bg-teal-600 px-3 py-2 text-xs font-medium text-white hover:bg-teal-700 disabled:opacity-50"
          >
            Şimdi Gönder
          </button>
        </div>
      </div>
      {result && (
        <pre className="mt-3 whitespace-pre-wrap rounded-lg bg-zinc-50 px-3 py-2 text-xs text-zinc-700">
          {result}
        </pre>
      )}
    </div>
  );
}
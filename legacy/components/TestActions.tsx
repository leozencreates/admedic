"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function TestActions({ testId, status }: { testId: string; status: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(action: "run" | "sync" | "stop", opts?: { pushToMeta?: boolean }) {
    setBusy(action);
    setResult(null);
    setError(null);
    try {
      let res: Response;
      if (action === "run") {
        res = await fetch(`/api/tests/${testId}/run`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pushToMeta: opts?.pushToMeta ?? false }),
        });
      } else if (action === "sync") {
        res = await fetch("/api/meta/sync", { method: "POST" });
      } else {
        res = await fetch(`/api/tests/${testId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "STOPPED" }),
        });
      }
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "İşlem başarısız");
      if (action === "run") {
        if (d.skipped) {
          setResult(`Atlandı: ${d.reason}`);
        } else {
          setResult(
            `${d.decision.action} — ${d.decision.detail}${d.metaPushError ? `\nMeta hatası: ${d.metaPushError}` : ""}`
          );
        }
      } else if (action === "sync") {
        setResult(d.message ?? "Senkronize edildi.");
      } else {
        setResult("Test durduruldu.");
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Bilinmeyen hata");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3 rounded-xl border border-zinc-200 bg-white p-4">
      <div className="flex flex-wrap gap-2">
        {status === "RUNNING" && (
          <>
            <button
              onClick={() => run("run")}
              disabled={busy === "run"}
              className="rounded-lg bg-teal-600 px-3 py-2 text-xs font-medium text-white hover:bg-teal-700 disabled:opacity-50"
            >
              {busy === "run" ? "Çalışıyor…" : "Agent'ı Çalıştır"}
            </button>
            <button
              onClick={() => run("run", { pushToMeta: true })}
              disabled={!!busy}
              className="rounded-lg border border-zinc-300 px-3 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
            >
              Çalıştır + Bütçeyi Meta&apos;ya Uygula
            </button>
            <button
              onClick={() => run("sync")}
              disabled={!!busy}
              className="rounded-lg border border-zinc-300 px-3 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
            >
              Meta&apos;dan Veri Çek
            </button>
            <button
              onClick={() => run("stop")}
              disabled={!!busy}
              className="rounded-lg border border-red-200 px-3 py-2 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
            >
              Testi Durdur
            </button>
          </>
        )}
      </div>
      {result && (
        <pre className="whitespace-pre-wrap rounded-lg bg-zinc-50 px-3 py-2 text-xs text-zinc-700">
          {result}
        </pre>
      )}
      {error && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      )}
    </div>
  );
}
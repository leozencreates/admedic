"use client";
import { useState } from "react";
import { api } from "../_lib/client-api";
import { formatDate } from "../_lib/format";
import type { ConnectionReport } from "../_lib/go-live";
import { CheckList } from "./check-list";

interface Result {
  live: boolean;
  connections: ConnectionReport[];
  checkedAt: string;
}

/** Meta bağlantılarının canlı, salt okunur denetimi (hesap sahibi; Meta'ya yazmaz). */
export function MetaCheck() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);

  async function run() {
    setBusy(true);
    setError("");
    try {
      setResult(await api<Result>("/api/go-live/meta-check", "POST", {}));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Denetim tamamlanamadı. Birkaç dakika sonra tekrar deneyin.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="primary-button" disabled={busy} onClick={() => void run()}>
          {busy ? "Denetleniyor…" : "Meta bağlantılarını denetle"}
        </button>
        <p className="text-sm text-ink-3">Yalnızca okur; Meta&apos;da hiçbir şey değiştirmez.</p>
      </div>
      {error ? (
        <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
          {error}
        </p>
      ) : null}
      <div role="status">
        {result && !result.live ? (
          <p className="text-sm text-ink-2">Deneme modunda Meta&apos;ya bağlanılmaz; canlı denetim yapılmadı.</p>
        ) : null}
        {result && result.live && result.connections.length === 0 ? (
          <p className="text-sm text-ink-2">Etkin Meta bağlantısı yok. Önce Meta bağlantıları sayfasından bağlanın.</p>
        ) : null}
      </div>
      {result?.connections.map((c) => (
        <section key={c.id} aria-labelledby={`baglanti-${c.id}`} className="rounded-lg border border-line p-4">
          <h3 id={`baglanti-${c.id}`} className="font-semibold text-ink">
            {c.name}
          </h3>
          <CheckList checks={c.checks} />
        </section>
      ))}
      {result ? <p className="text-xs text-ink-3">Son denetim: {formatDate(result.checkedAt)}</p> : null}
    </div>
  );
}

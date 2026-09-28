"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { api } from "../_lib/client-api";

/** Uyarı durum düğmeleri: "Görüldü olarak işaretle" (ACKED) ve "Çözüldü olarak kapat" (RESOLVED). */
export function AlertActions({ id, status, title }: { id: string; status: string; title?: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (status === "RESOLVED") return null;

  async function update(next: "ACKED" | "RESOLVED") {
    setBusy(true);
    setError("");
    try {
      await api(`/api/alerts/${id}`, "PATCH", { status: next });
      startTransition(() => router.refresh());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Uyarı güncellenemedi. Sayfayı yenileyip tekrar deneyin.");
    } finally {
      setBusy(false);
    }
  }

  const disabled = busy || pending;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {status === "OPEN" ? (
        <button type="button" className="secondary-button text-xs" disabled={disabled} onClick={() => void update("ACKED")}>
          Görüldü olarak işaretle{title ? <span className="sr-only">: {title}</span> : null}
        </button>
      ) : null}
      <button type="button" className="primary-button text-xs" disabled={disabled} onClick={() => void update("RESOLVED")}>
        Çözüldü olarak kapat{title ? <span className="sr-only">: {title}</span> : null}
      </button>
      {error ? (
        <span className="text-xs text-rose-700" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

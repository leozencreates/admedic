"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { api } from "../_lib/client-api";

/** Uyarı durum butonları: "Görüldü" (ACKED) ve "Çözüldü" (RESOLVED). */
export function AlertActions({ id, status }: { id: string; status: string }) {
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
      setError(e instanceof Error ? e.message : "Güncellenemedi.");
    } finally {
      setBusy(false);
    }
  }

  const disabled = busy || pending;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {status === "OPEN" ? (
        <button type="button" className="secondary-button text-xs" disabled={disabled} onClick={() => void update("ACKED")}>
          Görüldü
        </button>
      ) : null}
      <button type="button" className="primary-button text-xs" disabled={disabled} onClick={() => void update("RESOLVED")}>
        Çözüldü
      </button>
      {error ? (
        <span className="text-xs text-rose-600" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

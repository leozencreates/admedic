"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

export function UploadMediaForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const file = inputRef.current?.files?.[0];
    if (!file) return;
    setBusy(true);
    const fd = new FormData();
    fd.append("file", file);
    fd.append("name", file.name.replace(/\.[^.]+$/, ""));
    fd.append("type", file.type.startsWith("video/") ? "VIDEO" : "IMAGE");
    try {
      const res = await fetch("/api/media", { method: "POST", body: fd });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "Yükleme başarısız");
      if (inputRef.current) inputRef.current.value = "";
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Bilinmeyen hata");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3 rounded-xl border border-dashed border-zinc-300 bg-white p-4">
      <p className="text-sm font-medium">Fotoğraf / Video Yükle</p>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/svg+xml,video/mp4"
        required
        className="text-sm"
      />
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <div>
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-medium text-white hover:bg-teal-700 disabled:opacity-50"
        >
          {busy ? "Yükleniyor…" : "Yükle"}
        </button>
      </div>
      <p className="text-xs text-zinc-500">
        Bu görseller/videolar otomatik WhatsApp takiplerinde rotasyonla paylaşılır.
      </p>
    </form>
  );
}
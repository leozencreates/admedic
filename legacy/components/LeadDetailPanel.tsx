"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function LeadDetailPanel({
  leadId,
  status,
  mediaAssets,
}: {
  leadId: string;
  status: string;
  mediaAssets: { id: string; name: string; url: string; type: string }[];
}) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [mediaId, setMediaId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);

  const STATUS_OPTIONS = [
    { value: "NEW", label: "Yeni" },
    { value: "CONTACTED", label: "İletişim Kuruldu" },
    { value: "CONVERSING", label: "Görüşme" },
    { value: "WON", label: "Kazanıldı" },
    { value: "LOST", label: "Kaybedildi" },
    { value: "DND", label: "Rahatsız Etme" },
  ];

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    if (!body.trim() && !mediaId) return;
    setBusy(true);
    try {
      const asset = mediaAssets.find((m) => m.id === mediaId);
      const res = await fetch(`/api/leads/${leadId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body: body.trim() || undefined,
          mediaUrl: asset?.url,
          mediaType: asset?.type,
        }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "Gönderilemedi");
      setBody("");
      setInfo(d.mock ? "Mesaj simülasyonda gönderildi (Mock)." : "Mesaj gönderildi.");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Bilinmeyen hata");
    } finally {
      setBusy(false);
    }
  }

  async function updateStatus(next: string) {
    setStatusBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/leads/${leadId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      if (!res.ok) throw new Error("Durum güncellenemedi");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Bilinmeyen hata");
    } finally {
      setStatusBusy(false);
    }
  }

  return (
    <div className="space-y-4 rounded-xl border border-zinc-200 bg-white p-4">
      <div>
        <label className="mb-1 block text-sm font-medium">Lead Durumu</label>
        <select
          value={status}
          disabled={statusBusy}
          onChange={(e) => updateStatus(e.target.value)}
          className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      <form onSubmit={send} className="space-y-3">
        <label className="mb-1 block text-sm font-medium">WhatsApp Mesajı</label>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={4}
          placeholder="Merhaba…"
          className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
        />
        <div>
          <label className="mb-1 block text-sm font-medium">Medya Paylaş (opsiyonel)</label>
          <select
            value={mediaId}
            onChange={(e) => setMediaId(e.target.value)}
            className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
          >
            <option value="">Medya yok</option>
            {mediaAssets.map((m) => (
              <option key={m.id} value={m.id}>
                [{m.type === "VIDEO" ? "Video" : "Foto"}] {m.name}
              </option>
            ))}
          </select>
        </div>
        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        {info && <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{info}</p>}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-lg bg-teal-600 px-4 py-2 text-sm font-medium text-white hover:bg-teal-700 disabled:opacity-50"
        >
          {busy ? "Gönderiliyor…" : "Gönder"}
        </button>
      </form>
    </div>
  );
}
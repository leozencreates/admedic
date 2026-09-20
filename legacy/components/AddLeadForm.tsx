"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

export function AddLeadForm() {
  const router = useRouter();
  const [busy, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    setIsPending(true);
    const form = e.currentTarget;
    const data = new FormData(form);
    try {
      const res = await fetch("/api/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: data.get("name"),
          phone: data.get("phone"),
          country: data.get("country"),
          source: data.get("source") || "MANUAL",
          sendWelcome: data.get("sendWelcome") === "on",
        }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "Lead eklenemedi");
      setSuccess(true);
      formRef.current?.reset();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Bilinmeyen hata");
    } finally {
      setIsPending(false);
    }
  }

  return (
    <form ref={formRef} onSubmit={onSubmit} className="space-y-3 rounded-xl border border-zinc-200 bg-white p-4">
      <p className="text-sm font-medium">Yeni Lead Ekle</p>
      <div className="grid gap-3 md:grid-cols-2">
        <input
          name="name"
          required
          placeholder="Ad Soyad"
          className="rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
        />
        <input
          name="phone"
          required
          placeholder="+49 151 2345 6789"
          className="rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
        />
        <input
          name="country"
          placeholder="Ülke (örn. DE)"
          className="rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
        />
        <select
          name="source"
          className="rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
        >
          <option value="MANUAL">Manuel</option>
          <option value="META_LEAD">Meta Lead Formu</option>
          <option value="FORM">Web Formu</option>
        </select>
      </div>
      <label className="flex items-center gap-2 text-sm text-zinc-600">
        <input name="sendWelcome" type="checkbox" defaultChecked className="h-4 w-4 rounded border-zinc-300" />
        Karşılama mesajını hemen planla (WhatsApp)
      </label>
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {success && (
        <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          Lead eklendi; takip planı kurulacak.
        </p>
      )}
      <div className="flex justify-end">
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-medium text-white hover:bg-teal-700 disabled:opacity-50"
        >
          {busy ? "Ekleniyor…" : "Ekle"}
        </button>
      </div>
    </form>
  );
}
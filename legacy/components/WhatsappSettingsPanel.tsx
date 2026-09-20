"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PROVIDER_LABEL } from "@/lib/whatsapp/client";

interface Config {
  provider: string;
  phoneNumberId: string | null;
  businessAccountId: string | null;
  fromNumber: string | null;
  dailyReminderHour: number;
  dailyReminderIntervalDays: number;
  followUpDelayHours: number;
  winbackDelayDays: number;
  active: boolean;
}

export function WhatsappSettingsPanel() {
  const [config, setConfig] = useState<Config | null>(null);
  const [hasToken, setHasToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/whatsapp")
      .then((r) => r.json())
      .then((d) => {
        setConfig(d.config);
        setHasToken(d.hasWhatsappToken);
      })
      .catch(() => setError("Ayarlar yüklenemedi."));
  }, []);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const form = new FormData(e.currentTarget);
    const payload = {
      provider: String(form.get("provider")),
      phoneNumberId: String(form.get("phoneNumberId") || ""),
      businessAccountId: String(form.get("businessAccountId") || ""),
      fromNumber: String(form.get("fromNumber") || ""),
      dailyReminderHour: Number(form.get("dailyReminderHour")),
      dailyReminderIntervalDays: Number(form.get("dailyReminderIntervalDays")),
      followUpDelayHours: Number(form.get("followUpDelayHours")),
      winbackDelayDays: Number(form.get("winbackDelayDays")),
      active: form.get("active") === "on",
    };
    try {
      const res = await fetch("/api/whatsapp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "Kaydedilemedi");
      setConfig(d.config);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Bilinmeyen hata");
    } finally {
      setBusy(false);
    }
  }

  if (!config) {
    return <p className="text-sm text-zinc-500">Yükleniyor…</p>;
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5 rounded-xl border border-zinc-200 bg-white p-6">
      <div className="flex items-center justify-between">
        <p className="font-medium">WhatsApp Entegrasyonu</p>
        <label className="flex items-center gap-2 text-sm text-zinc-600">
          <input
            name="active"
            type="checkbox"
            defaultChecked={config.active}
            className="h-4 w-4 rounded border-zinc-300"
          />
          Aktif
        </label>
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium">Sağlayıcı</label>
        <select
          name="provider"
          defaultValue={config.provider}
          className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
        >
          {Object.entries(PROVIDER_LABEL).map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-zinc-500">
          Mock: güvenli test (hiçbir mesaj gerçekten gönderilmez).
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <label className="mb-1 block text-sm font-medium">Phone Number ID</label>
          <input
            name="phoneNumberId"
            defaultValue={config.phoneNumberId ?? ""}
            placeholder="11-digit sayı (Meta içinde)"
            className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium">Business Account ID</label>
          <input
            name="businessAccountId"
            defaultValue={config.businessAccountId ?? ""}
            className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium">Gönderen Numara</label>
          <input
            name="fromNumber"
            defaultValue={config.fromNumber ?? ""}
            placeholder="+90 212 000 00 00"
            className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium">WHATSAPP_TOKEN (.env)</label>
          <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm">
            {hasToken ? (
              <span className="text-emerald-700">Tanımlı ✓</span>
            ) : (
              <span className="text-amber-700">Eksik — Mock modu etkin</span>
            )}
          </div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <div>
          <label className="mb-1 block text-sm font-medium">Hatırlatma Saati</label>
          <input
            name="dailyReminderHour"
            type="number"
            min={0}
            max={23}
            defaultValue={config.dailyReminderHour}
            className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium">Hatırlatma Aralığı (gün)</label>
          <input
            name="dailyReminderIntervalDays"
            type="number"
            min={1}
            max={30}
            defaultValue={config.dailyReminderIntervalDays}
            className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium">Takip Gecikmesi (saat)</label>
          <input
            name="followUpDelayHours"
            type="number"
            min={1}
            max={168}
            defaultValue={config.followUpDelayHours}
            className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium">Kazan-kazan Sınırı (gün)</label>
          <input
            name="winbackDelayDays"
            type="number"
            min={7}
            max={60}
            defaultValue={config.winbackDelayDays}
            className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
          />
        </div>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {saved && (
        <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          Ayarlar kaydedildi.
        </p>
      )}

      <div className="flex items-center justify-between border-t border-zinc-100 pt-4">
        <p className="text-xs text-zinc-500">
          Lead takip akışı: karşılama → 24 saat sonra takip → günlük hatırlatma + klinik medyası.
        </p>
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-medium text-white hover:bg-teal-700 disabled:opacity-50"
        >
          {busy ? "Kaydediliyor…" : "Kaydet"}
        </button>
      </div>

      <p className="text-xs text-zinc-500">
        Meta Business üzerinden WhatsApp Cloud API kurulumu ve token için{" "}
        <Link href="/meta" className="text-teal-700 underline">
          Meta Bağlantısı
        </Link>{" "}
        sayfasına bakın.
      </p>
    </form>
  );
}
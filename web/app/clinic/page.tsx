"use client";
import { useState, useEffect } from "react";
import { api } from "../_lib/client-api";
import { Card, EmptyState, SectionHeading, Badge } from "../_components/ui";

type Clinic = {
  id: string;
  name: string;
  slug: string;
  category: string;
  status: string;
  licenseNumber: string | null;
  accreditations: string[];
  brandLogo: string | null;
  brandColors: string[];
  brandTone: string | null;
  brandBannedPhrases: string[];
};

type OrgSettings = {
  retentionDays: number;
  consentText: string | null;
};

export default function ClinicPage() {
  const [clinics, setClinics] = useState<Clinic[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const [form, setForm] = useState({
    licenseNumber: "",
    accreditations: "",
    brandLogo: "",
    brandColors: "",
    brandTone: "",
    brandBannedPhrases: "",
  });
  const [settingsForm, setSettingsForm] = useState({ retentionDays: 365, consentText: "" });

  async function load() {
    setLoading(true);
    try {
      const [c, o] = await Promise.all([
        api<{ clinics: Clinic[] }>(`/api/clinics`),
        api<{ settings: OrgSettings }>(`/api/org/settings`),
      ]);
      setClinics(c.clinics);
      setSettingsForm({
        retentionDays: o.settings?.retentionDays ?? 365,
        consentText: o.settings?.consentText ?? "",
      });
    } catch (e) {
      setNotice((e as Error).message ?? "Veri alınamadı.");
    }
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  async function select(id: string) {
    setSelectedId(id);
    const clinic = clinics.find((c) => c.id === id) ?? (await api<{ clinic: Clinic }>(`/api/clinics/${id}`)).clinic;
    setForm({
      licenseNumber: clinic.licenseNumber ?? "",
      accreditations: (clinic.accreditations ?? []).join(", "),
      brandLogo: clinic.brandLogo ?? "",
      brandColors: (clinic.brandColors ?? []).join(", "),
      brandTone: clinic.brandTone ?? "",
      brandBannedPhrases: (clinic.brandBannedPhrases ?? []).join(", "),
    });
  }

  async function saveBrand(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedId) return;
    setNotice("");
    try {
      const payload = {
        ...(form.licenseNumber.trim() ? { licenseNumber: form.licenseNumber.trim() } : { licenseNumber: null }),
        accreditations: form.accreditations.split(",").map((s) => s.trim()).filter(Boolean),
        ...(form.brandLogo.trim() ? { brandLogo: form.brandLogo.trim() } : { brandLogo: null }),
        brandColors: form.brandColors.split(",").map((s) => s.trim()).filter(Boolean),
        ...(form.brandTone.trim() ? { brandTone: form.brandTone.trim() } : { brandTone: null }),
        brandBannedPhrases: form.brandBannedPhrases.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
      };
      await api(`/api/clinics/${selectedId}`, "PATCH", JSON.stringify(payload));
      setNotice("Klinik profil & marka kılavuzu kaydedildi.");
      load();
    } catch (e) {
      setNotice((e as Error).message ?? "Kaydedilemedi.");
    }
  }

  async function saveSettings(e: React.FormEvent) {
    e.preventDefault();
    setNotice("");
    try {
      await api("/api/org/settings", "PATCH", JSON.stringify({
        retentionDays: settingsForm.retentionDays,
        consentText: settingsForm.consentText.trim() || null,
      }));
      setNotice("Organizasyon ayarları kaydedildi.");
      load();
    } catch (e) {
      setNotice((e as Error).message ?? "Kaydedilemedi.");
    }
  }

  const selected = clinics.find((c) => c.id === selectedId) ?? null;

  return (
    <div className="space-y-6">
      <section>
        <SectionHeading title="Klinik Profili & Marka Kılavuzu" description="Yasaklı ifadeler politika kontrolüne ve LLM üretimine beslenir." />
        {notice && <p className="mt-2 text-sm text-emerald-400">{notice}</p>}
      </section>

      {loading ? (
        <p className="text-sm text-slate-400">Yükleniyor…</p>
      ) : clinics.length === 0 ? (
        <EmptyState message="Klinik profili bulunamadı. Önce Klinikler üzerinden ekleyin." />
      ) : (
        <Card>
          <div className="flex flex-wrap gap-2">
            {clinics.map((c) => (
              <button
                key={c.id}
                onClick={() => select(c.id)}
                className={`rounded-lg px-3 py-2 text-sm font-medium ${
                  selectedId === c.id
                    ? "bg-violet-500/20 text-violet-200 ring-1 ring-violet-400/30"
                    : "bg-white/5 text-slate-300 hover:bg-white/10"
                }`}
              >
                {c.name}
                {c.category !== "MEDICAL" && <span className="ml-1 text-xs text-slate-500">({c.category})</span>}
              </button>
            ))}
          </div>

          {selected && (
            <form onSubmit={saveBrand} className="mt-6 grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-sm">
                Lisans/Ruhsat No (Sağlık Bakanlığı)
                <input className="rounded bg-slate-900/60 px-3 py-2 text-sm" value={form.licenseNumber} onChange={(e) => setForm({ ...form, licenseNumber: e.target.value })} placeholder="örn. SB-2024-12345" />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                Akreditasyonlar (virgülle)
                <input className="rounded bg-slate-900/60 px-3 py-2 text-sm" value={form.accreditations} onChange={(e) => setForm({ ...form, accreditations: e.target.value })} placeholder="ISO 9001, JCI" />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                Marka Logosu URL
                <input className="rounded bg-slate-900/60 px-3 py-2 text-sm" value={form.brandLogo} onChange={(e) => setForm({ ...form, brandLogo: e.target.value })} placeholder="https://…" />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                Marka Renkleri (hex, virgülle)
                <input className="rounded bg-slate-900/60 px-3 py-2 text-sm" value={form.brandColors} onChange={(e) => setForm({ ...form, brandColors: e.target.value })} placeholder="#1e3a8a, #f59e0b" />
              </label>
              <label className="flex flex-col gap-1 text-sm sm:col-span-2">
                Marka Ton/Vibe Kılavuzu
                <textarea className="rounded bg-slate-900/60 px-3 py-2 text-sm" rows={2} value={form.brandTone} onChange={(e) => setForm({ ...form, brandTone: e.target.value })} placeholder="Güven verici, tıbbi iddia içermeyen, hasta odaklı…" />
              </label>
              <label className="flex flex-col gap-1 text-sm sm:col-span-2">
                <span className="flex items-center gap-2">
                  Yasaklı İfadeler (virgülle)
                  <Badge tone="red">politika kontrolüne gider</Badge>
                </span>
                <textarea className="rounded bg-slate-900/60 px-3 py-2 text-sm" rows={2} value={form.brandBannedPhrases} onChange={(e) => setForm({ ...form, brandBannedPhrases: e.target.value })} placeholder="garanti sonuç, %100 başarı, ağrısız tedavi" />
              </label>
              <button className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-500 sm:col-span-2" type="submit">
                Profil & Marka Kılavuzunu Kaydet
              </button>
            </form>
          )}
        </Card>
      )}

      <Card>
        <SectionHeading title="Organizasyon Ayarları" description="Veri saklama süresi ve KVKK aydınlatma metni." />
        <form onSubmit={saveSettings} className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            Lead Saklama Süresi (gün)
            <input type="number" min={30} max={3650} className="rounded bg-slate-900/60 px-3 py-2 text-sm" value={settingsForm.retentionDays} onChange={(e) => setSettingsForm({ ...settingsForm, retentionDays: Number(e.target.value) })} />
          </label>
          <label className="flex flex-col gap-1 text-sm sm:col-span-2">
            Onay/Aydınlatma Metni
            <textarea className="rounded bg-slate-900/60 px-3 py-2 text-sm" rows={3} value={settingsForm.consentText} onChange={(e) => setSettingsForm({ ...settingsForm, consentText: e.target.value })} placeholder="KVKK aydınlatma metni… (boşsa varsayılan metin kullanılır)" />
          </label>
          <button className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-500" type="submit">
            Kaydet
          </button>
        </form>
      </Card>
    </div>
  );
}
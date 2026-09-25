"use client";
import { useState, useEffect } from "react";
import { api } from "../_lib/client-api";
import { Card, EmptyState, SectionHeading, Badge } from "../_components/ui";
import { LANG_LABEL, BRIEF_LANGUAGES } from "../_lib/creative-lang";

type Clinic = {
  id: string;
  name: string;
  slug: string;
  category: string;
  status: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  description: string | null;
  languages: string[];
  targetMarket: string | null;
  licenseNumber: string | null;
  accreditations: string[];
  brandLogo: string | null;
  brandColors: string[];
  brandTone: string | null;
  brandBannedPhrases: string[];
};

type Service = {
  id: string;
  name: string;
  slug: string;
  category: string;
  priceCents: number | null;
  packageIncludes: string[];
  showStartingPrice: boolean;
  status: string;
};

type MarketTarget = {
  id: string;
  country: string;
  language: string;
  currency: string;
  demand: number;
};

type OrgSettings = {
  retentionDays: number;
  consentText: string | null;
};

const TARGET_MARKET_LABEL: Record<string, string> = {
  TURKEY: "Türkiye",
  GERMANY: "Almanya",
  UK: "Birleşik Krallık",
  NETHERLANDS: "Hollanda",
  USA: "ABD",
  GULF: "Körfez Ülkeleri",
  OTHER: "Diğer",
};
const CATEGORY_LABEL: Record<string, string> = {
  MEDICAL: "Tıbbi",
  DENTAL: "Diş",
  WELLNESS: "Sağlıklı Yaşam",
  SURGICAL: "Cerrahi",
  DIAGNOSTIC: "Teşhis",
  PSYCHIATRIC: "Psikiyatri",
  OTHER: "Diğer",
};

export default function ClinicPage() {
  const [clinics, setClinics] = useState<Clinic[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const [form, setForm] = useState({
    address: "",
    phone: "",
    email: "",
    website: "",
    description: "",
    languages: [] as string[],
    targetMarket: "TURKEY",
    licenseNumber: "",
    accreditations: "",
    brandLogo: "",
    brandColors: "",
    brandTone: "",
    brandBannedPhrases: "",
  });
  const [services, setServices] = useState<Service[]>([]);
  const [serviceForm, setServiceForm] = useState({ name: "", slug: "", category: "MEDICAL", priceCents: "", packageIncludes: "" });
  const [targets, setTargets] = useState<MarketTarget[]>([]);
  const [targetForm, setTargetForm] = useState({ country: "", language: "TR", currency: "EUR", demand: "" });
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

  function toggleLanguage(code: string) {
    setForm((f) => ({
      ...f,
      languages: f.languages.includes(code)
        ? f.languages.filter((l) => l !== code)
        : [...f.languages, code],
    }));
  }

  async function loadDetails(id: string) {
    try {
      const { clinic } = await api<{ clinic: Clinic }>(`/api/clinics/${id}`);
      setForm({
        address: clinic.address ?? "",
        phone: clinic.phone ?? "",
        email: clinic.email ?? "",
        website: clinic.website ?? "",
        description: clinic.description ?? "",
        languages: (clinic.languages ?? []).slice(),
        targetMarket: clinic.targetMarket ?? "TURKEY",
        licenseNumber: clinic.licenseNumber ?? "",
        accreditations: (clinic.accreditations ?? []).join(", "),
        brandLogo: clinic.brandLogo ?? "",
        brandColors: (clinic.brandColors ?? []).join(", "),
        brandTone: clinic.brandTone ?? "",
        brandBannedPhrases: (clinic.brandBannedPhrases ?? []).join(", "),
      });
    } catch (e) {
      setNotice((e as Error).message ?? "Profil yüklenemedi.");
    }
  }

  async function loadCatalog(id: string) {
    try {
      const [s, t] = await Promise.all([
        api<{ services: Service[] }>(`/api/services/clinics/${id}`),
        api<{ targets: MarketTarget[] }>(`/api/clinics/${id}/targets`),
      ]);
      setServices(s.services ?? []);
      setTargets(t.targets ?? []);
    } catch {
      setServices([]);
      setTargets([]);
    }
  }

  async function select(id: string) {
    setSelectedId(id);
    await Promise.all([loadDetails(id), loadCatalog(id)]);
  }

  async function saveBrand(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedId) return;
    setNotice("");
    try {
      const payload = {
        address: form.address.trim() || null,
        phone: form.phone.trim() || null,
        ...(form.email.trim() ? { email: form.email.trim() } : { email: null }),
        ...(form.website.trim() ? { website: form.website.trim() } : { website: null }),
        description: form.description.trim() || null,
        languages: form.languages,
        targetMarket: form.targetMarket,
        ...(form.licenseNumber.trim() ? { licenseNumber: form.licenseNumber.trim() } : { licenseNumber: null }),
        accreditations: form.accreditations.split(",").map((s) => s.trim()).filter(Boolean),
        ...(form.brandLogo.trim() ? { brandLogo: form.brandLogo.trim() } : { brandLogo: null }),
        brandColors: form.brandColors.split(",").map((s) => s.trim()).filter(Boolean),
        ...(form.brandTone.trim() ? { brandTone: form.brandTone.trim() } : { brandTone: null }),
        brandBannedPhrases: form.brandBannedPhrases.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
      };
      await api(`/api/clinics/${selectedId}`, "PATCH", JSON.stringify(payload));
      setNotice("Klinik profili & marka kılavuzu kaydedildi.");
      load();
    } catch (e) {
      setNotice((e as Error).message ?? "Kaydedilemedi.");
    }
  }

  async function addService(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedId || !serviceForm.name || !serviceForm.slug) return;
    setNotice("");
    try {
      await api(`/api/services/clinics/${selectedId}`, "POST", JSON.stringify({
        name: serviceForm.name.trim(),
        slug: serviceForm.slug.trim(),
        category: serviceForm.category,
        ...(serviceForm.priceCents ? { priceCents: Math.round(parseFloat(serviceForm.priceCents) * 100) } : {}),
        packageIncludes: serviceForm.packageIncludes.split(",").map((s) => s.trim()).filter(Boolean),
      }));
      setServiceForm({ name: "", slug: "", category: "MEDICAL", priceCents: "", packageIncludes: "" });
      setNotice("Hizmet eklendi.");
      loadCatalog(selectedId);
    } catch (e) {
      setNotice((e as Error).message ?? "Hizmet eklenemedi.");
    }
  }

  async function archiveService(id: string) {
    setNotice("");
    try {
      await api(`/api/services/${id}`, "DELETE");
      loadCatalog(selectedId!);
    } catch (e) {
      setNotice((e as Error).message ?? "Hizmet arşivlenemedi.");
    }
  }

  async function addTarget(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedId || !targetForm.country.trim()) return;
    setNotice("");
    try {
      await api(`/api/clinics/${selectedId}/targets`, "POST", JSON.stringify({
        country: targetForm.country.trim().toUpperCase(),
        language: targetForm.language,
        currency: targetForm.currency.trim() || "EUR",
        ...(targetForm.demand ? { demand: parseFloat(targetForm.demand) } : {}),
      }));
      setTargetForm({ country: "", language: "TR", currency: "EUR", demand: "" });
      setNotice("Pazar hedefi kaydedildi.");
      loadCatalog(selectedId);
    } catch (e) {
      setNotice((e as Error).message ?? "Pazar hedefi kaydedilemedi.");
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
        <SectionHeading title="Klinik Profili & Marka Kılavuzu" description="Diller, hedef pazar ve yasaklı ifadeler üretime ve politika kontrolüne beslenir." />
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
                {c.category !== "MEDICAL" && <span className="ml-1 text-xs text-slate-500">({CATEGORY_LABEL[c.category] ?? c.category})</span>}
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
                Adres
                <input className="rounded bg-slate-900/60 px-3 py-2 text-sm" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} placeholder="Şehir, ülke…" />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                Telefon
                <input className="rounded bg-slate-900/60 px-3 py-2 text-sm" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+90…" />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                E-posta
                <input className="rounded bg-slate-900/60 px-3 py-2 text-sm" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="info@klinik.com" />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                Web sitesi
                <input className="rounded bg-slate-900/60 px-3 py-2 text-sm" value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} placeholder="https://…" />
              </label>
              <label className="flex flex-col gap-1 text-sm sm:col-span-2">
                Tarif
                <textarea className="rounded bg-slate-900/60 px-3 py-2 text-sm" rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Kuruluş, uzmanlıklar…" />
              </label>
              <div className="flex flex-col gap-1 text-sm sm:col-span-2">
                <span>Desteklenen Diller</span>
                <div className="flex flex-wrap gap-2">
                  {BRIEF_LANGUAGES.map((l) => (
                    <button
                      type="button"
                      key={l}
                      onClick={() => toggleLanguage(l)}
                      className={`rounded-lg px-3 py-1.5 text-xs font-medium ${
                        form.languages.includes(l)
                          ? "bg-violet-500/25 text-violet-100 ring-1 ring-violet-400/40"
                          : "bg-slate-900/60 text-slate-400 hover:bg-slate-800"
                      }`}
                    >
                      {LANG_LABEL[l]}
                    </button>
                  ))}
                </div>
              </div>
              <label className="flex flex-col gap-1 text-sm">
                Hedef Pazar
                <select className="rounded bg-slate-900/60 px-3 py-2 text-sm" value={form.targetMarket} onChange={(e) => setForm({ ...form, targetMarket: e.target.value })}>
                  {Object.entries(TARGET_MARKET_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
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

      {selected && (
        <>
          <Card>
            <SectionHeading title="Hizmet Kataloğu" description="Başlangıç fiyatları üretime ve reklam metnine gerçek veri olarak beslenir." />
            <form onSubmit={addService} className="mt-4 grid gap-3 sm:grid-cols-5">
              <input className="rounded bg-slate-900/60 px-3 py-2 text-sm" value={serviceForm.name} onChange={(e) => setServiceForm({ ...serviceForm, name: e.target.value })} placeholder="Hizmet adı" />
              <input className="rounded bg-slate-900/60 px-3 py-2 text-sm" value={serviceForm.slug} onChange={(e) => setServiceForm({ ...serviceForm, slug: e.target.value })} placeholder="slug" />
              <select className="rounded bg-slate-900/60 px-3 py-2 text-sm" value={serviceForm.category} onChange={(e) => setServiceForm({ ...serviceForm, category: e.target.value })}>
                {Object.keys(CATEGORY_LABEL).map((k) => <option key={k} value={k}>{CATEGORY_LABEL[k]}</option>)}
              </select>
              <input type="number" step="0.01" className="rounded bg-slate-900/60 px-3 py-2 text-sm" value={serviceForm.priceCents} onChange={(e) => setServiceForm({ ...serviceForm, priceCents: e.target.value })} placeholder="Başlangıç fiyatı" />
              <button className="rounded-lg bg-slate-800 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700" type="submit">Ekle</button>
              <input className="rounded bg-slate-900/60 px-3 py-2 text-sm sm:col-span-5" value={serviceForm.packageIncludes} onChange={(e) => setServiceForm({ ...serviceForm, packageIncludes: e.target.value })} placeholder="Paket kapsamı (virgülle): otel, transfer, tercüman" />
            </form>
            {services.length === 0 ? <EmptyState message="Henüz hizmet yok." /> : (
              <div className="mt-4 space-y-2">
                {services.map((s) => (
                  <div key={s.id} className="flex items-center justify-between rounded-lg border border-slate-200/60 p-2.5">
                    <div>
                      <p className="text-sm font-medium text-slate-200">{s.name} {s.status !== "ACTIVE" && <span className="text-xs text-slate-500">({s.status})</span>}</p>
                      <p className="text-xs text-slate-400">{CATEGORY_LABEL[s.category] ?? s.category}{s.priceCents ? ` · ${s.showStartingPrice ? "Başlangıç " : ""}€${(s.priceCents / 100).toFixed(0)}` : ""}</p>
                    </div>
                    {s.status === "ACTIVE" && (
                      <button onClick={() => archiveService(s.id)} className="rounded bg-slate-800 px-2 py-1 text-xs text-slate-300 hover:bg-slate-700">Arşivle</button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card>
            <SectionHeading title="Pazar Hedefleri" description="Ülke + dil + para birimi; kampanya planlamasına beslenir." />
            <form onSubmit={addTarget} className="mt-4 grid gap-3 sm:grid-cols-5">
              <input className="rounded bg-slate-900/60 px-3 py-2 text-sm" value={targetForm.country} onChange={(e) => setTargetForm({ ...targetForm, country: e.target.value })} placeholder="Ülke kodu (DE)" />
              <select className="rounded bg-slate-900/60 px-3 py-2 text-sm" value={targetForm.language} onChange={(e) => setTargetForm({ ...targetForm, language: e.target.value })}>
                {BRIEF_LANGUAGES.map((l) => <option key={l} value={l}>{LANG_LABEL[l]}</option>)}
              </select>
              <input className="rounded bg-slate-900/60 px-3 py-2 text-sm" value={targetForm.currency} onChange={(e) => setTargetForm({ ...targetForm, currency: e.target.value })} placeholder="Para birimi (EUR)" />
              <input type="number" className="rounded bg-slate-900/60 px-3 py-2 text-sm" value={targetForm.demand} onChange={(e) => setTargetForm({ ...targetForm, demand: e.target.value })} placeholder="Talep skoru" />
              <button className="rounded-lg bg-slate-800 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700" type="submit">Ekle</button>
            </form>
            {targets.length === 0 ? <EmptyState message="Henüz pazar hedefi yok." /> : (
              <div className="mt-4 flex flex-wrap gap-2">
                {targets.map((t) => (
                  <span key={t.id} className="rounded-full border border-slate-200/60 px-3 py-1 text-xs text-slate-300">
                    {t.country} · {LANG_LABEL[t.language] ?? t.language} · {t.currency}{t.demand > 0 ? ` · talep ${t.demand}` : ""}
                  </span>
                ))}
              </div>
            )}
          </Card>
        </>
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
"use client";
import { useState, useEffect } from "react";
import { api } from "../_lib/client-api";
import { Card, EmptyState, SectionHeading, Badge } from "../_components/ui";
import { LANG_LABEL, BRIEF_LANGUAGES } from "../_lib/creative-lang";
import { slugify } from "../_lib/slug";

type Clinic = {
  id: string;
  name: string;
  slug: string;
  category: string;
  status: string;
  city: string | null;
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
  description: string | null;
  durationDays: number | null;
  priceCents: number | null;
  currency: string;
  packageIncludes: string[];
  showStartingPrice: boolean;
  status: string;
};

type MarketTarget = {
  id: string;
  country: string;
  region: string | null;
  language: string;
  currency: string;
  demand: number;
};

type OrgSettings = {
  retentionDays: number;
  consentText: string | null;
};

type ServiceForm = {
  name: string;
  slug: string;
  category: string;
  price: string;
  currency: string;
  durationDays: string;
  packageIncludes: string;
  description: string;
  showStartingPrice: boolean;
};
const EMPTY_SERVICE: ServiceForm = {
  name: "", slug: "", category: "MEDICAL", price: "", currency: "EUR", durationDays: "",
  packageIncludes: "", description: "", showStartingPrice: true,
};

type TargetForm = { country: string; region: string; language: string; currency: string; demand: string };
const EMPTY_TARGET: TargetForm = { country: "", region: "", language: "TR", currency: "EUR", demand: "" };

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

function money(cents: number, currency: string) {
  try {
    return new Intl.NumberFormat("tr-TR", { style: "currency", currency, maximumFractionDigits: 0 }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(0)} ${currency}`;
  }
}

export default function ClinicPage() {
  const [clinics, setClinics] = useState<Clinic[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ name: "", category: "MEDICAL", city: "", address: "" });
  const [form, setForm] = useState({
    name: "",
    city: "",
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
  const [serviceForm, setServiceForm] = useState<ServiceForm>(EMPTY_SERVICE);
  const [editingService, setEditingService] = useState<string | null>(null);
  const [targets, setTargets] = useState<MarketTarget[]>([]);
  const [targetForm, setTargetForm] = useState<TargetForm>(EMPTY_TARGET);
  const [editingTarget, setEditingTarget] = useState<string | null>(null);
  const [settingsForm, setSettingsForm] = useState({ retentionDays: 365, consentText: "" });

  const ok = (text: string) => setNotice({ kind: "ok", text });
  const fail = (e: unknown, fallback: string) => setNotice({ kind: "err", text: (e as Error)?.message || fallback });

  async function load() {
    setLoading(true);
    try {
      const c = await api<{ clinics: Clinic[] }>(`/api/clinics`);
      setClinics(c.clinics);
      if (c.clinics.length === 0) setShowCreate(true);
    } catch (e) {
      fail(e, "Veri alınamadı.");
    }
    try {
      const o = await api<{ settings: OrgSettings }>(`/api/org/settings`);
      setSettingsForm({
        retentionDays: o.settings?.retentionDays ?? 365,
        consentText: o.settings?.consentText ?? "",
      });
    } catch {
      /* organizasyon ayarları yetkisi olmayan roller için sessiz */
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
        name: clinic.name ?? "",
        city: clinic.city ?? "",
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
      fail(e, "Profil yüklenemedi.");
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
    setEditingService(null);
    setEditingTarget(null);
    setServiceForm(EMPTY_SERVICE);
    setTargetForm(EMPTY_TARGET);
    await Promise.all([loadDetails(id), loadCatalog(id)]);
  }

  async function createClinic(e: React.FormEvent) {
    e.preventDefault();
    if (!createForm.name.trim()) return;
    setNotice(null);
    try {
      const { clinic } = await api<{ clinic: Clinic }>(`/api/clinics`, "POST", {
        name: createForm.name.trim(),
        category: createForm.category,
        ...(createForm.city.trim() ? { city: createForm.city.trim() } : {}),
        ...(createForm.address.trim() ? { address: createForm.address.trim() } : {}),
      });
      ok(`"${clinic.name}" kliniği oluşturuldu.`);
      setCreateForm({ name: "", category: "MEDICAL", city: "", address: "" });
      setShowCreate(false);
      await load();
      await select(clinic.id);
    } catch (e) {
      fail(e, "Klinik oluşturulamadı.");
    }
  }

  async function saveBrand(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedId) return;
    setNotice(null);
    try {
      const payload = {
        ...(form.name.trim() ? { name: form.name.trim() } : {}),
        city: form.city.trim() || null,
        address: form.address.trim() || null,
        phone: form.phone.trim() || null,
        email: form.email.trim() || null,
        website: form.website.trim() || null,
        description: form.description.trim() || null,
        languages: form.languages,
        targetMarket: form.targetMarket,
        licenseNumber: form.licenseNumber.trim() || null,
        accreditations: form.accreditations.split(",").map((s) => s.trim()).filter(Boolean),
        brandLogo: form.brandLogo.trim() || null,
        brandColors: form.brandColors.split(",").map((s) => s.trim()).filter(Boolean),
        brandTone: form.brandTone.trim() || null,
        brandBannedPhrases: form.brandBannedPhrases.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
      };
      // Düz nesne gönderilir; `api()` JSON'a çevirir (çift kodlama yok).
      const r = await api<{ changed: string[] }>(`/api/clinics/${selectedId}`, "PATCH", payload);
      ok(r.changed.length > 0 ? "Klinik profili & marka kılavuzu kaydedildi." : "Değişiklik yok.");
      load();
    } catch (e) {
      fail(e, "Kaydedilemedi.");
    }
  }

  function serviceToForm(s: Service): ServiceForm {
    return {
      name: s.name,
      slug: s.slug,
      category: s.category,
      price: s.priceCents !== null ? String(s.priceCents / 100) : "",
      currency: s.currency ?? "EUR",
      durationDays: s.durationDays !== null ? String(s.durationDays) : "",
      packageIncludes: s.packageIncludes.join(", "),
      description: s.description ?? "",
      showStartingPrice: s.showStartingPrice,
    };
  }
  function servicePayload(f: ServiceForm) {
    const price = f.price.trim() ? Math.round(parseFloat(f.price) * 100) : null;
    const duration = f.durationDays.trim() ? parseInt(f.durationDays, 10) : null;
    return {
      name: f.name.trim(),
      ...(f.slug.trim() ? { slug: f.slug.trim() } : {}),
      category: f.category,
      priceCents: price !== null && Number.isFinite(price) && price > 0 ? price : null,
      currency: f.currency.trim().toUpperCase() || "EUR",
      durationDays: duration !== null && Number.isFinite(duration) && duration > 0 ? duration : null,
      packageIncludes: f.packageIncludes.split(",").map((s) => s.trim()).filter(Boolean),
      description: f.description.trim() || null,
      showStartingPrice: f.showStartingPrice,
    };
  }

  async function submitService(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedId || !serviceForm.name.trim()) return;
    setNotice(null);
    try {
      if (editingService) {
        const r = await api<{ changed: string[] }>(`/api/services/${editingService}`, "PATCH", servicePayload(serviceForm));
        ok(r.changed.length > 0 ? "Hizmet güncellendi." : "Değişiklik yok.");
      } else {
        await api(`/api/services/clinics/${selectedId}`, "POST", servicePayload(serviceForm));
        ok("Hizmet eklendi.");
      }
      setServiceForm(EMPTY_SERVICE);
      setEditingService(null);
      loadCatalog(selectedId);
    } catch (e) {
      fail(e, editingService ? "Hizmet güncellenemedi." : "Hizmet eklenemedi.");
    }
  }

  async function archiveService(id: string) {
    if (!window.confirm("Hizmet arşivlenecek. Emin misiniz?")) return;
    setNotice(null);
    try {
      await api(`/api/services/${id}`, "DELETE");
      ok("Hizmet arşivlendi.");
      loadCatalog(selectedId!);
    } catch (e) {
      fail(e, "Hizmet arşivlenemedi.");
    }
  }

  async function setServiceStatus(id: string, status: "ACTIVE" | "PAUSED") {
    setNotice(null);
    try {
      await api(`/api/services/${id}`, "PATCH", { status });
      loadCatalog(selectedId!);
    } catch (e) {
      fail(e, "Hizmet durumu güncellenemedi.");
    }
  }

  async function submitTarget(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedId) return;
    setNotice(null);
    try {
      const demand = targetForm.demand.trim() ? parseFloat(targetForm.demand) : undefined;
      const common = {
        language: targetForm.language,
        currency: targetForm.currency.trim().toUpperCase() || "EUR",
        ...(targetForm.region.trim() ? { region: targetForm.region.trim() } : {}),
        ...(demand !== undefined && Number.isFinite(demand) ? { demand } : {}),
      };
      if (editingTarget) {
        await api(`/api/clinics/${selectedId}/targets/${encodeURIComponent(editingTarget)}`, "PATCH", common);
        ok("Pazar hedefi güncellendi.");
      } else {
        if (!targetForm.country.trim()) return;
        await api(`/api/clinics/${selectedId}/targets`, "POST", {
          country: targetForm.country.trim().toUpperCase(),
          ...common,
        });
        ok("Pazar hedefi kaydedildi.");
      }
      setTargetForm(EMPTY_TARGET);
      setEditingTarget(null);
      loadCatalog(selectedId);
    } catch (e) {
      fail(e, "Pazar hedefi kaydedilemedi.");
    }
  }

  async function deleteTarget(country: string) {
    if (!selectedId || !window.confirm(`${country} pazar hedefi silinecek. Emin misiniz?`)) return;
    setNotice(null);
    try {
      await api(`/api/clinics/${selectedId}/targets/${encodeURIComponent(country)}`, "DELETE");
      ok("Pazar hedefi silindi.");
      if (editingTarget === country) {
        setEditingTarget(null);
        setTargetForm(EMPTY_TARGET);
      }
      loadCatalog(selectedId);
    } catch (e) {
      fail(e, "Pazar hedefi silinemedi.");
    }
  }

  async function saveSettings(e: React.FormEvent) {
    e.preventDefault();
    setNotice(null);
    try {
      await api("/api/org/settings", "PATCH", {
        retentionDays: settingsForm.retentionDays,
        consentText: settingsForm.consentText.trim() || null,
      });
      ok("Organizasyon ayarları kaydedildi.");
      load();
    } catch (e) {
      fail(e, "Kaydedilemedi.");
    }
  }

  const selected = clinics.find((c) => c.id === selectedId) ?? null;
  const inputCls = "rounded bg-slate-900/60 px-3 py-2 text-sm";

  return (
    <div className="space-y-6">
      <section>
        <SectionHeading
          title="Klinik Profili & Marka Kılavuzu"
          description="Diller, hedef pazar ve yasaklı ifadeler üretime ve politika kontrolüne beslenir."
          action={
            <button type="button" onClick={() => setShowCreate((v) => !v)} className="rounded-lg bg-slate-800 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700">
              {showCreate ? "Formu Gizle" : "+ Yeni Klinik"}
            </button>
          }
        />
        {notice && (
          <p role="alert" className={`mt-2 text-sm ${notice.kind === "ok" ? "text-emerald-400" : "text-rose-400"}`}>{notice.text}</p>
        )}
      </section>

      {showCreate && (
        <Card>
          <SectionHeading title="Klinik Oluştur" description="Ad ve kategori yeterlidir; slug addan türetilir, diğer alanlar sonra düzenlenir." />
          <form onSubmit={createClinic} className="grid gap-3 sm:grid-cols-4">
            <label className="flex flex-col gap-1 text-sm sm:col-span-2">
              Klinik adı
              <input required className={inputCls} value={createForm.name} onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })} placeholder="örn. Özen Diş Kliniği" />
              {createForm.name.trim() && <span className="text-xs text-slate-500">slug: {slugify(createForm.name)}</span>}
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Kategori
              <select className={inputCls} value={createForm.category} onChange={(e) => setCreateForm({ ...createForm, category: e.target.value })}>
                {Object.entries(CATEGORY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Şehir
              <input className={inputCls} value={createForm.city} onChange={(e) => setCreateForm({ ...createForm, city: e.target.value })} placeholder="Antalya" />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Adres
              <input className={inputCls} value={createForm.address} onChange={(e) => setCreateForm({ ...createForm, address: e.target.value })} placeholder="Mahalle, cadde, no" />
            </label>
            <button className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-500 sm:col-span-4" type="submit">
              Kliniği Oluştur
            </button>
          </form>
        </Card>
      )}

      {loading ? (
        <p className="text-sm text-slate-400">Yükleniyor…</p>
      ) : clinics.length === 0 ? (
        <EmptyState message="Henüz klinik profili yok. Yukarıdaki formdan ilk kliniğinizi oluşturun." />
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
          {!selected && <p className="mt-3 text-xs text-slate-500">Düzenlemek için bir klinik seçin.</p>}

          {selected && (
            <form onSubmit={saveBrand} className="mt-6 grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-sm">
                Klinik adı
                <input className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                Lisans/Ruhsat No (Sağlık Bakanlığı)
                <input className={inputCls} value={form.licenseNumber} onChange={(e) => setForm({ ...form, licenseNumber: e.target.value })} placeholder="örn. SB-2024-12345" />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                Akreditasyonlar (virgülle)
                <input className={inputCls} value={form.accreditations} onChange={(e) => setForm({ ...form, accreditations: e.target.value })} placeholder="ISO 9001, JCI" />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                Şehir
                <input className={inputCls} value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} placeholder="Antalya" />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                Adres
                <input className={inputCls} value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} placeholder="Mahalle, cadde, no…" />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                Telefon
                <input className={inputCls} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+90…" />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                E-posta
                <input className={inputCls} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="info@klinik.com" />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                Web sitesi
                <input className={inputCls} value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} placeholder="https://…" />
              </label>
              <label className="flex flex-col gap-1 text-sm sm:col-span-2">
                Tarif
                <textarea className={inputCls} rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Kuruluş, uzmanlıklar…" />
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
                <select className={inputCls} value={form.targetMarket} onChange={(e) => setForm({ ...form, targetMarket: e.target.value })}>
                  {Object.entries(TARGET_MARKET_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm">
                Marka Logosu URL
                <input className={inputCls} value={form.brandLogo} onChange={(e) => setForm({ ...form, brandLogo: e.target.value })} placeholder="https://…" />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                Marka Renkleri (hex, virgülle)
                <input className={inputCls} value={form.brandColors} onChange={(e) => setForm({ ...form, brandColors: e.target.value })} placeholder="#1e3a8a, #f59e0b" />
              </label>
              <label className="flex flex-col gap-1 text-sm sm:col-span-2">
                Marka Ton/Vibe Kılavuzu
                <textarea className={inputCls} rows={2} value={form.brandTone} onChange={(e) => setForm({ ...form, brandTone: e.target.value })} placeholder="Güven verici, tıbbi iddia içermeyen, hasta odaklı…" />
              </label>
              <label className="flex flex-col gap-1 text-sm sm:col-span-2">
                <span className="flex items-center gap-2">
                  Yasaklı İfadeler (virgülle)
                  <Badge tone="red">politika kontrolüne gider</Badge>
                </span>
                <textarea className={inputCls} rows={2} value={form.brandBannedPhrases} onChange={(e) => setForm({ ...form, brandBannedPhrases: e.target.value })} placeholder="garanti sonuç, %100 başarı, ağrısız tedavi" />
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
            <form onSubmit={submitService} className="mt-4 grid gap-3 sm:grid-cols-6">
              <input required className={`${inputCls} sm:col-span-2`} value={serviceForm.name} onChange={(e) => setServiceForm({ ...serviceForm, name: e.target.value })} placeholder="Hizmet adı" />
              <input className={inputCls} value={serviceForm.slug} onChange={(e) => setServiceForm({ ...serviceForm, slug: e.target.value })} placeholder={serviceForm.name.trim() ? slugify(serviceForm.name) : "slug (otomatik)"} />
              <select className={inputCls} value={serviceForm.category} onChange={(e) => setServiceForm({ ...serviceForm, category: e.target.value })}>
                {Object.keys(CATEGORY_LABEL).map((k) => <option key={k} value={k}>{CATEGORY_LABEL[k]}</option>)}
              </select>
              <input type="number" step="0.01" min="0" className={inputCls} value={serviceForm.price} onChange={(e) => setServiceForm({ ...serviceForm, price: e.target.value })} placeholder="Başlangıç fiyatı" />
              <input className={inputCls} maxLength={3} value={serviceForm.currency} onChange={(e) => setServiceForm({ ...serviceForm, currency: e.target.value })} placeholder="EUR" />
              <input type="number" min="1" className={inputCls} value={serviceForm.durationDays} onChange={(e) => setServiceForm({ ...serviceForm, durationDays: e.target.value })} placeholder="Süre (gün)" />
              <input className={`${inputCls} sm:col-span-3`} value={serviceForm.packageIncludes} onChange={(e) => setServiceForm({ ...serviceForm, packageIncludes: e.target.value })} placeholder="Paket kapsamı (virgülle): otel, transfer, tercüman" />
              <input className={`${inputCls} sm:col-span-2`} value={serviceForm.description} onChange={(e) => setServiceForm({ ...serviceForm, description: e.target.value })} placeholder="Kısa açıklama" />
              <label className="flex items-center gap-2 text-sm sm:col-span-4">
                <input type="checkbox" checked={serviceForm.showStartingPrice} onChange={(e) => setServiceForm({ ...serviceForm, showStartingPrice: e.target.checked })} />
                &quot;Başlangıç fiyatı&quot; reklam metninde gösterilsin
              </label>
              <div className="flex gap-2 sm:col-span-2">
                <button className="rounded-lg bg-slate-800 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700" type="submit">
                  {editingService ? "Güncelle" : "Ekle"}
                </button>
                {editingService && (
                  <button type="button" onClick={() => { setEditingService(null); setServiceForm(EMPTY_SERVICE); }} className="rounded-lg border border-slate-600 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800">
                    Vazgeç
                  </button>
                )}
              </div>
            </form>
            {services.length === 0 ? <EmptyState message="Henüz hizmet yok." /> : (
              <div className="mt-4 space-y-2">
                {services.map((s) => (
                  <div key={s.id} className={`flex items-center justify-between rounded-lg border border-slate-200/60 p-2.5 ${editingService === s.id ? "ring-1 ring-violet-400/40" : ""}`}>
                    <div>
                      <p className="text-sm font-medium text-slate-200">
                        {s.name} {s.status !== "ACTIVE" && <span className="text-xs text-slate-500">({s.status})</span>}
                      </p>
                      <p className="text-xs text-slate-400">
                        {CATEGORY_LABEL[s.category] ?? s.category}
                        {s.priceCents ? ` · ${s.showStartingPrice ? "Başlangıç " : ""}${money(s.priceCents, s.currency || "EUR")}` : ""}
                        {s.priceCents && !s.showStartingPrice ? " (fiyat reklamda gizli)" : ""}
                        {s.durationDays ? ` · ${s.durationDays} gün` : ""}
                        {s.packageIncludes.length > 0 ? ` · ${s.packageIncludes.join(", ")}` : ""}
                      </p>
                    </div>
                    <div className="flex gap-1">
                      {s.status !== "ARCHIVED" && (
                        <button onClick={() => { setEditingService(s.id); setServiceForm(serviceToForm(s)); }} className="rounded bg-slate-800 px-2 py-1 text-xs text-slate-300 hover:bg-slate-700">Düzenle</button>
                      )}
                      {s.status === "ACTIVE" && (
                        <button onClick={() => setServiceStatus(s.id, "PAUSED")} className="rounded bg-slate-800 px-2 py-1 text-xs text-slate-300 hover:bg-slate-700">Duraklat</button>
                      )}
                      {s.status === "PAUSED" && (
                        <button onClick={() => setServiceStatus(s.id, "ACTIVE")} className="rounded bg-emerald-700 px-2 py-1 text-xs text-white hover:bg-emerald-600">Etkinleştir</button>
                      )}
                      {s.status === "ARCHIVED" ? (
                        <button onClick={() => setServiceStatus(s.id, "ACTIVE")} className="rounded bg-slate-800 px-2 py-1 text-xs text-slate-300 hover:bg-slate-700">Geri Al</button>
                      ) : (
                        <button onClick={() => archiveService(s.id)} className="rounded bg-rose-700 px-2 py-1 text-xs text-white hover:bg-rose-600">Arşivle</button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card>
            <SectionHeading title="Pazar Hedefleri" description="Ülke + dil + para birimi; kampanya planlamasına beslenir." />
            <form onSubmit={submitTarget} className="mt-4 grid gap-3 sm:grid-cols-6">
              <input
                className={inputCls}
                value={editingTarget ?? targetForm.country}
                disabled={editingTarget !== null}
                onChange={(e) => setTargetForm({ ...targetForm, country: e.target.value })}
                placeholder="Ülke kodu (DE)"
                maxLength={3}
              />
              <input className={inputCls} value={targetForm.region} onChange={(e) => setTargetForm({ ...targetForm, region: e.target.value })} placeholder="Bölge (opsiyonel)" />
              <select className={inputCls} value={targetForm.language} onChange={(e) => setTargetForm({ ...targetForm, language: e.target.value })}>
                {BRIEF_LANGUAGES.map((l) => <option key={l} value={l}>{LANG_LABEL[l]}</option>)}
              </select>
              <input className={inputCls} maxLength={3} value={targetForm.currency} onChange={(e) => setTargetForm({ ...targetForm, currency: e.target.value })} placeholder="Para birimi (EUR)" />
              <input type="number" min="0" step="0.1" className={inputCls} value={targetForm.demand} onChange={(e) => setTargetForm({ ...targetForm, demand: e.target.value })} placeholder="Talep skoru" />
              <div className="flex gap-2">
                <button className="rounded-lg bg-slate-800 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700" type="submit">
                  {editingTarget ? "Güncelle" : "Ekle"}
                </button>
                {editingTarget && (
                  <button type="button" onClick={() => { setEditingTarget(null); setTargetForm(EMPTY_TARGET); }} className="rounded-lg border border-slate-600 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800">
                    Vazgeç
                  </button>
                )}
              </div>
            </form>
            {targets.length === 0 ? <EmptyState message="Henüz pazar hedefi yok." /> : (
              <div className="mt-4 flex flex-wrap gap-2">
                {targets.map((t) => (
                  <span key={t.id} className={`flex items-center gap-2 rounded-full border border-slate-200/60 px-3 py-1 text-xs text-slate-300 ${editingTarget === t.country ? "ring-1 ring-violet-400/40" : ""}`}>
                    {t.country}{t.region ? `/${t.region}` : ""} · {LANG_LABEL[t.language] ?? t.language} · {t.currency}{t.demand > 0 ? ` · talep ${t.demand}` : ""}
                    <button
                      type="button"
                      onClick={() => {
                        setEditingTarget(t.country);
                        setTargetForm({ country: t.country, region: t.region ?? "", language: t.language, currency: t.currency, demand: t.demand > 0 ? String(t.demand) : "" });
                      }}
                      className="text-violet-300 hover:underline"
                    >
                      Düzenle
                    </button>
                    <button type="button" onClick={() => deleteTarget(t.country)} className="text-rose-300 hover:underline">Sil</button>
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
            <input type="number" min={30} max={3650} className={inputCls} value={settingsForm.retentionDays} onChange={(e) => setSettingsForm({ ...settingsForm, retentionDays: Number(e.target.value) })} />
          </label>
          <label className="flex flex-col gap-1 text-sm sm:col-span-2">
            Onay/Aydınlatma Metni
            <textarea className={inputCls} rows={3} value={settingsForm.consentText} onChange={(e) => setSettingsForm({ ...settingsForm, consentText: e.target.value })} placeholder="KVKK aydınlatma metni… (boşsa varsayılan metin kullanılır)" />
          </label>
          <button className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-500" type="submit">
            Kaydet
          </button>
        </form>
      </Card>
    </div>
  );
}

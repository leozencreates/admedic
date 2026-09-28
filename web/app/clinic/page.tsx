"use client";
import { useState, useEffect } from "react";
import { api } from "../_lib/client-api";
import { Card, EmptyState, SectionHeading, Badge } from "../_components/ui";
import { ConfirmDialog } from "../_components/dialog";
import { BRIEF_LANGUAGES } from "../_lib/creative-lang";
import { countryName, entityStatusStyle, languageName } from "../_lib/labels";
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
  privacyNoticeText: string | null;
  privacyPolicyUrl: string | null;
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
  const [settingsForm, setSettingsForm] = useState({
    retentionDays: 365,
    consentText: "",
    privacyNoticeText: "",
    privacyPolicyUrl: "",
  });
  /** Geri alınamayan işlemler için onay (tarayıcının confirm penceresi yerine). */
  const [pendingConfirm, setPendingConfirm] = useState<
    { kind: "archiveService"; id: string; name: string } | { kind: "deleteTarget"; country: string } | null
  >(null);

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
        privacyNoticeText: o.settings?.privacyNoticeText ?? "",
        privacyPolicyUrl: o.settings?.privacyPolicyUrl ?? "",
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
    setPendingConfirm(null);
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
    setPendingConfirm(null);
    if (!selectedId) return;
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
        privacyNoticeText: settingsForm.privacyNoticeText.trim() || null,
        privacyPolicyUrl: settingsForm.privacyPolicyUrl.trim() || null,
      });
      ok("Çalışma alanı ayarları kaydedildi.");
      load();
    } catch (e) {
      fail(e, "Kaydedilemedi.");
    }
  }

  const selected = clinics.find((c) => c.id === selectedId) ?? null;
  const inputCls = "input";

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Klinik ve marka</h1>
          <p className="mt-1 text-sm text-muted">
            Diller, hedef pazar ve yasaklı ifadeler reklam üretimine ve içerik kontrolüne beslenir.
          </p>
        </div>
        <button type="button" onClick={() => setShowCreate((v) => !v)} className="secondary-button" aria-expanded={showCreate}>
          {showCreate ? "Formu gizle" : "+ Yeni klinik"}
        </button>
      </header>
      {notice && (
        <p
          role={notice.kind === "ok" ? "status" : "alert"}
          className={`rounded-lg border p-3 text-sm ${notice.kind === "ok" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-rose-200 bg-rose-50 text-rose-800"}`}
        >
          {notice.text}
        </p>
      )}

      {showCreate && (
        <Card>
          <SectionHeading title="Klinik oluştur" description="Ad ve kategori yeterlidir; web adresindeki kısa ad addan türetilir, diğer alanlar sonra düzenlenir." />
          <form onSubmit={createClinic} className="grid gap-3 sm:grid-cols-4">
            <label className="field sm:col-span-2">
              Klinik adı
              <input required className={inputCls} value={createForm.name} onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })} placeholder="örn. Özen Diş Kliniği" />
              {createForm.name.trim() && <span className="text-xs text-muted">Kısa ad (web adresinde): {slugify(createForm.name)}</span>}
            </label>
            <label className="field">
              Kategori
              <select className={inputCls} value={createForm.category} onChange={(e) => setCreateForm({ ...createForm, category: e.target.value })}>
                {Object.entries(CATEGORY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
            <label className="field">
              Şehir
              <input className={inputCls} value={createForm.city} onChange={(e) => setCreateForm({ ...createForm, city: e.target.value })} placeholder="Antalya" />
            </label>
            <label className="field">
              Adres
              <input className={inputCls} value={createForm.address} onChange={(e) => setCreateForm({ ...createForm, address: e.target.value })} placeholder="Mahalle, cadde, no" />
            </label>
            <button className="primary-button sm:col-span-4" type="submit">
              Kliniği oluştur
            </button>
          </form>
        </Card>
      )}

      {loading ? (
        <p role="status" className="text-sm text-muted">Yükleniyor…</p>
      ) : clinics.length === 0 ? (
        <EmptyState message="Henüz klinik profili yok. Yukarıdaki formdan ilk kliniğinizi oluşturun." />
      ) : (
        <Card>
          <div className="flex flex-wrap gap-2">
            {clinics.map((c) => (
              <button
                type="button"
                key={c.id}
                onClick={() => select(c.id)}
                aria-pressed={selectedId === c.id}
                className={`min-h-10 rounded-lg px-3 py-2 text-sm font-medium ${
                  selectedId === c.id
                    ? "bg-violet-50 text-violet-900 ring-1 ring-violet-300"
                    : "bg-white text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50"
                }`}
              >
                {c.name}
                {c.category !== "MEDICAL" && <span className="ml-1 text-xs text-muted">({CATEGORY_LABEL[c.category] ?? c.category})</span>}
              </button>
            ))}
          </div>
          {!selected && <p className="mt-3 text-xs text-muted">Düzenlemek için bir klinik seçin.</p>}

          {selected && (
            <form onSubmit={saveBrand} className="mt-6 grid gap-3 sm:grid-cols-2">
              <label className="field">
                Klinik adı
                <input className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </label>
              <label className="field">
                Uluslararası Sağlık Turizmi Yetki Belgesi No
                <input className={inputCls} value={form.licenseNumber} onChange={(e) => setForm({ ...form, licenseNumber: e.target.value })} placeholder="örn. SB-2024-12345" />
              </label>
              <label className="field">
                Akreditasyonlar (virgülle)
                <input className={inputCls} value={form.accreditations} onChange={(e) => setForm({ ...form, accreditations: e.target.value })} placeholder="ISO 9001, JCI" />
              </label>
              <label className="field">
                Şehir
                <input className={inputCls} value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} placeholder="Antalya" />
              </label>
              <label className="field">
                Adres
                <input className={inputCls} value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} placeholder="Mahalle, cadde, no…" />
              </label>
              <label className="field">
                Telefon
                <input className={inputCls} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+90…" />
              </label>
              <label className="field">
                E-posta
                <input className={inputCls} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="info@klinik.com" />
              </label>
              <label className="field">
                Web sitesi
                <input className={inputCls} value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} placeholder="https://…" />
              </label>
              <label className="field sm:col-span-2">
                Açıklama
                <textarea className={inputCls} rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Kuruluş, uzmanlıklar…" />
              </label>
              <div className="flex flex-col gap-1 text-sm sm:col-span-2">
                <span id="klinik-dilleri">Desteklenen diller</span>
                <div className="flex flex-wrap gap-2" role="group" aria-labelledby="klinik-dilleri">
                  {BRIEF_LANGUAGES.map((l) => {
                    const on = form.languages.includes(l);
                    return (
                      <button
                        type="button"
                        key={l}
                        onClick={() => toggleLanguage(l)}
                        aria-pressed={on}
                        className={`inline-flex min-h-9 items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium ${
                          on ? "bg-violet-50 text-violet-900 ring-1 ring-violet-300" : "bg-white text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50"
                        }`}
                      >
                        {on ? <span aria-hidden="true">✓</span> : null}
                        {languageName(l)}
                      </button>
                    );
                  })}
                </div>
              </div>
              <label className="field">
                Hedef pazar
                <select className={inputCls} value={form.targetMarket} onChange={(e) => setForm({ ...form, targetMarket: e.target.value })}>
                  {Object.entries(TARGET_MARKET_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </label>
              <label className="field">
                Marka logosu bağlantısı
                <input className={inputCls} value={form.brandLogo} onChange={(e) => setForm({ ...form, brandLogo: e.target.value })} placeholder="https://…" />
              </label>
              <label className="field">
                Marka renkleri (hex, virgülle)
                <input className={inputCls} value={form.brandColors} onChange={(e) => setForm({ ...form, brandColors: e.target.value })} placeholder="#1e3a8a, #f59e0b" />
              </label>
              <label className="field sm:col-span-2">
                Marka dili ve tonu
                <textarea className={inputCls} rows={2} value={form.brandTone} onChange={(e) => setForm({ ...form, brandTone: e.target.value })} placeholder="Güven verici, tıbbi iddia içermeyen, hasta odaklı…" />
              </label>
              <label className="field sm:col-span-2">
                <span className="flex items-center gap-2">
                  Yasaklı ifadeler (virgülle)
                  <Badge tone="gray">içerik kontrolüne gider</Badge>
                </span>
                <textarea className={inputCls} rows={2} value={form.brandBannedPhrases} onChange={(e) => setForm({ ...form, brandBannedPhrases: e.target.value })} placeholder="garanti sonuç, %100 başarı, ağrısız tedavi" />
              </label>
              <button className="primary-button sm:col-span-2" type="submit">
                Profili ve marka bilgilerini kaydet
              </button>
            </form>
          )}
        </Card>
      )}

      {selected && (
        <>
          <Card>
            <SectionHeading title="Hizmet kataloğu" description="Başlangıç fiyatları reklam üretimine ve metnine gerçek veri olarak beslenir." />
            <form onSubmit={submitService} className="mt-4 grid gap-3 sm:grid-cols-6">
              <label className="field sm:col-span-2">
                Hizmet adı
                <input required value={serviceForm.name} onChange={(e) => setServiceForm({ ...serviceForm, name: e.target.value })} placeholder="Saç ekimi" />
              </label>
              <label className="field">
                Kısa ad (isteğe bağlı)
                <input value={serviceForm.slug} onChange={(e) => setServiceForm({ ...serviceForm, slug: e.target.value })} placeholder={serviceForm.name.trim() ? slugify(serviceForm.name) : "otomatik"} />
              </label>
              <label className="field">
                Kategori
                <select value={serviceForm.category} onChange={(e) => setServiceForm({ ...serviceForm, category: e.target.value })}>
                  {Object.keys(CATEGORY_LABEL).map((k) => <option key={k} value={k}>{CATEGORY_LABEL[k]}</option>)}
                </select>
              </label>
              <label className="field">
                Başlangıç fiyatı
                <input type="number" step="0.01" min="0" value={serviceForm.price} onChange={(e) => setServiceForm({ ...serviceForm, price: e.target.value })} />
              </label>
              <label className="field">
                Para birimi
                <input maxLength={3} value={serviceForm.currency} onChange={(e) => setServiceForm({ ...serviceForm, currency: e.target.value })} placeholder="EUR" />
              </label>
              <label className="field">
                Süre (gün)
                <input type="number" min="1" value={serviceForm.durationDays} onChange={(e) => setServiceForm({ ...serviceForm, durationDays: e.target.value })} />
              </label>
              <label className="field sm:col-span-3">
                Paket kapsamı (virgülle)
                <input value={serviceForm.packageIncludes} onChange={(e) => setServiceForm({ ...serviceForm, packageIncludes: e.target.value })} placeholder="otel, transfer, tercüman" />
              </label>
              <label className="field sm:col-span-2">
                Kısa açıklama
                <input value={serviceForm.description} onChange={(e) => setServiceForm({ ...serviceForm, description: e.target.value })} />
              </label>
              <label className="flex items-center gap-2 text-sm sm:col-span-4">
                <input type="checkbox" checked={serviceForm.showStartingPrice} onChange={(e) => setServiceForm({ ...serviceForm, showStartingPrice: e.target.checked })} />
                &quot;Başlangıç fiyatı&quot; reklam metninde gösterilsin
              </label>
              <div className="flex gap-2 sm:col-span-2">
                <button className="secondary-button" type="submit">
                  {editingService ? "Hizmeti güncelle" : "Hizmet ekle"}
                </button>
                {editingService && (
                  <button type="button" onClick={() => { setEditingService(null); setServiceForm(EMPTY_SERVICE); }} className="secondary-button">
                    Vazgeç
                  </button>
                )}
              </div>
            </form>
            {services.length === 0 ? <EmptyState message="Henüz hizmet yok." /> : (
              <div className="mt-4 space-y-2">
                {services.map((s) => (
                  <div key={s.id} className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 p-3 ${editingService === s.id ? "ring-2 ring-violet-300" : ""}`}>
                    <div>
                      <p className="text-sm font-medium text-slate-900">
                        {s.name} {s.status !== "ACTIVE" && <span className="text-xs text-muted">({entityStatusStyle(s.status).label})</span>}
                      </p>
                      <p className="text-xs text-muted">
                        {CATEGORY_LABEL[s.category] ?? s.category}
                        {s.priceCents ? ` · ${s.showStartingPrice ? "Başlangıç " : ""}${money(s.priceCents, s.currency || "EUR")}` : ""}
                        {s.priceCents && !s.showStartingPrice ? " (fiyat reklamda gizli)" : ""}
                        {s.durationDays ? ` · ${s.durationDays} gün` : ""}
                        {s.packageIncludes.length > 0 ? ` · ${s.packageIncludes.join(", ")}` : ""}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {s.status !== "ARCHIVED" && (
                        <button type="button" onClick={() => { setEditingService(s.id); setServiceForm(serviceToForm(s)); }} className="secondary-button">Düzenle</button>
                      )}
                      {s.status === "ACTIVE" && (
                        <button type="button" onClick={() => setServiceStatus(s.id, "PAUSED")} className="secondary-button">Duraklat</button>
                      )}
                      {s.status === "PAUSED" && (
                        <button type="button" onClick={() => setServiceStatus(s.id, "ACTIVE")} className="secondary-button">Etkinleştir</button>
                      )}
                      {s.status === "ARCHIVED" ? (
                        <button type="button" onClick={() => setServiceStatus(s.id, "ACTIVE")} className="secondary-button">Arşivden çıkar</button>
                      ) : (
                        <button type="button" onClick={() => setPendingConfirm({ kind: "archiveService", id: s.id, name: s.name })} className="secondary-button">Arşivle</button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card>
            <SectionHeading title="Pazar hedefleri" description="Ülke, dil ve para birimi kampanya planlamasına beslenir." />
            <form onSubmit={submitTarget} className="mt-4 grid gap-3 sm:grid-cols-6">
              <label className="field">
                Ülke kodu
                <input
                  value={editingTarget ?? targetForm.country}
                  disabled={editingTarget !== null}
                  onChange={(e) => setTargetForm({ ...targetForm, country: e.target.value })}
                  placeholder="DE"
                  maxLength={3}
                />
              </label>
              <label className="field">
                Bölge (isteğe bağlı)
                <input value={targetForm.region} onChange={(e) => setTargetForm({ ...targetForm, region: e.target.value })} />
              </label>
              <label className="field">
                Dil
                <select value={targetForm.language} onChange={(e) => setTargetForm({ ...targetForm, language: e.target.value })}>
                  {BRIEF_LANGUAGES.map((l) => <option key={l} value={l}>{languageName(l)}</option>)}
                </select>
              </label>
              <label className="field">
                Para birimi
                <input maxLength={3} value={targetForm.currency} onChange={(e) => setTargetForm({ ...targetForm, currency: e.target.value })} placeholder="EUR" />
              </label>
              <label className="field">
                Talep puanı
                <input type="number" min="0" step="0.1" value={targetForm.demand} onChange={(e) => setTargetForm({ ...targetForm, demand: e.target.value })} />
              </label>
              <div className="flex items-end gap-2">
                <button className="secondary-button" type="submit">
                  {editingTarget ? "Hedefi güncelle" : "Hedef ekle"}
                </button>
                {editingTarget && (
                  <button type="button" onClick={() => { setEditingTarget(null); setTargetForm(EMPTY_TARGET); }} className="secondary-button">
                    Vazgeç
                  </button>
                )}
              </div>
            </form>
            {targets.length === 0 ? <EmptyState message="Henüz pazar hedefi yok." /> : (
              <div className="mt-4 flex flex-wrap gap-2">
                {targets.map((t) => (
                  <span key={t.id} className={`flex items-center gap-3 rounded-full border border-slate-300 px-3 py-1 text-xs text-slate-700 ${editingTarget === t.country ? "ring-2 ring-violet-300" : ""}`}>
                    {countryName(t.country)}{t.region ? ` / ${t.region}` : ""} · {languageName(t.language)} · {t.currency}{t.demand > 0 ? ` · talep ${t.demand}` : ""}
                    <button
                      type="button"
                      onClick={() => {
                        setEditingTarget(t.country);
                        setTargetForm({ country: t.country, region: t.region ?? "", language: t.language, currency: t.currency, demand: t.demand > 0 ? String(t.demand) : "" });
                      }}
                      className="min-h-8 font-medium text-brand-strong hover:underline"
                      aria-label={`Düzenle: ${countryName(t.country)}`}
                    >
                      Düzenle
                    </button>
                    <button
                      type="button"
                      onClick={() => setPendingConfirm({ kind: "deleteTarget", country: t.country })}
                      className="min-h-8 font-medium text-rose-700 hover:underline"
                      aria-label={`Sil: ${countryName(t.country)}`}
                    >
                      Sil
                    </button>
                  </span>
                ))}
              </div>
            )}
          </Card>
        </>
      )}

      <Card>
        <SectionHeading
          title="Çalışma alanı ayarları"
          description="Lead saklama süresi ve KVKK metinleri. Aydınlatma metni ile açık rıza metni ayrı tutulur (KVKK Kurulu İlke Kararı 2026/347)."
        />
        <form onSubmit={saveSettings} className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="field">
            Lead saklama süresi (gün)
            <input type="number" min={30} max={3650} value={settingsForm.retentionDays} onChange={(e) => setSettingsForm({ ...settingsForm, retentionDays: Number(e.target.value) })} />
            <span className="text-xs font-normal text-muted">Süresi dolan lead&apos;ler anonimleştirilir.</span>
          </label>
          <label className="field">
            Aydınlatma metni bağlantısı (https)
            <input type="url" value={settingsForm.privacyPolicyUrl} onChange={(e) => setSettingsForm({ ...settingsForm, privacyPolicyUrl: e.target.value })} placeholder="https://klinik.example/kvkk-aydinlatma" />
            <span className="text-xs font-normal text-muted">
              Aydınlatma metninizin yayımlandığı sayfa. Anında Form&apos;da &ldquo;Aydınlatma metni&rdquo; bağlantısı buraya gider; form yayını için zorunludur.
            </span>
          </label>
          <label className="field sm:col-span-2">
            Aydınlatma metni
            <textarea rows={6} value={settingsForm.privacyNoticeText} onChange={(e) => setSettingsForm({ ...settingsForm, privacyNoticeText: e.target.value })} />
            <span className="text-xs font-normal text-muted">
              Kişisel verilerin hangi amaçla, hangi hukuki sebeple işlendiğini ve kimlere aktarıldığını anlatır (KVKK md. 10). Yalnızca bilgi verir; hastadan onay istenmez.
              Metnin güncel hâlini yukarıdaki bağlantıdaki sayfada da yayımlayın.
            </span>
          </label>
          <label className="field sm:col-span-2">
            Açık rıza metni
            <textarea rows={3} value={settingsForm.consentText} onChange={(e) => setSettingsForm({ ...settingsForm, consentText: e.target.value })} />
            <span className="text-xs font-normal text-muted">
              Yalnızca rıza beyanı: hastanın neye açık rıza verdiği (ör. pazarlama iletişimi ve reklam ölçümü). Aydınlatma bilgileri buraya yazılmaz.
              Panelden kaydedilen rızaların kanıtına bu metin eklenir; Türkçe Anında Form&apos;larda &ldquo;Açık rıza&rdquo; bölümünde gösterilir. Boşsa varsayılan metin kullanılır.
            </span>
          </label>
          {settingsForm.consentText.trim() && !settingsForm.privacyNoticeText.trim() ? (
            <p role="note" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 sm:col-span-2">
              Önceki &ldquo;Onay/Aydınlatma Metni&rdquo; alanı artık yalnızca açık rıza metnidir. Mevcut metin aydınlatma bilgileri içeriyorsa bu bilgileri
              &ldquo;Aydınlatma metni&rdquo; alanına taşıyın; açık rıza metninde yalnızca rıza beyanı kalsın.
            </p>
          ) : null}
          <div className="sm:col-span-2">
            <button className="primary-button" type="submit">
              Ayarları kaydet
            </button>
          </div>
        </form>
      </Card>

      <ConfirmDialog
        open={pendingConfirm !== null}
        title={pendingConfirm?.kind === "deleteTarget" ? "Pazar hedefi silinsin mi?" : "Hizmet arşivlensin mi?"}
        description={
          pendingConfirm?.kind === "deleteTarget"
            ? `${countryName(pendingConfirm.country)} pazar hedefi silinecek. Kampanya planlaması bu hedefi artık kullanmaz.`
            : pendingConfirm?.kind === "archiveService"
              ? `"${pendingConfirm.name}" arşivlenecek. Arşivdeki hizmet reklam üretiminde kullanılmaz; sonradan arşivden çıkarabilirsiniz.`
              : undefined
        }
        confirmLabel={pendingConfirm?.kind === "deleteTarget" ? "Hedefi sil" : "Hizmeti arşivle"}
        tone="danger"
        onConfirm={() => {
          if (pendingConfirm?.kind === "deleteTarget") void deleteTarget(pendingConfirm.country);
          else if (pendingConfirm?.kind === "archiveService") void archiveService(pendingConfirm.id);
        }}
        onCancel={() => setPendingConfirm(null)}
      />
    </div>
  );
}

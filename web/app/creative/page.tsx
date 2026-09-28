"use client";
import { useState, useEffect, useId } from "react";
import { api, defaultAccountCurrency } from "../_lib/client-api";
import { formatDay } from "../_lib/format";
import { ctaDisplay, entityStatusStyle, languageName, policyRiskStyle, studioStatusStyle } from "../_lib/labels";
import { Badge, Card, EmptyState, SectionHeading } from "../_components/ui";
import { LANG_LABEL, BRIEF_LANGUAGES, rtlFor } from "../_lib/creative-lang";
interface CreativeData { id: string; name: string; status: string; languages: string[]; variations: number; policyRisk: string | null; primaryText?: string; headline?: string; createdAt: string; }
interface Variant { headline: string; text: string; description?: string; cta: string }
interface Finding { rule?: string; reason?: string; suggestion?: string; risk?: string }
interface LlmLayer { risk?: string; reason?: string; correctedCopy?: string; error?: boolean }
interface PolicyResult { risk: string; ruleRisk?: string; findings?: Finding[]; llm?: LlmLayer | null }
interface LanguageResult { language: string; variants: Variant[]; instantForm?: { questions: string[] }; whatsapp?: { welcome: string }; policy: PolicyResult }
interface GenerateResponse { policy: { risk: string } | null; results: LanguageResult[] }

/** Kreatif durumu: taslak/onay akışı stüdyo etiketleriyle, Meta'daki durum (ACTIVE/PAUSED) reklam etiketleriyle. */
function creativeStatusStyle(status: string) {
  return status === "ACTIVE" || status === "PAUSED" ? entityStatusStyle(status) : studioStatusStyle(status);
}

export default function CreativePage() {
  const [creatives, setCreatives] = useState<CreativeData[]>([]);
  const [loading, setLoading] = useState(true);
  // Yükleme hatası boş liste gibi gösterilmez (İÇ-3).
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [clinic, setClinic] = useState("");
  const [service, setService] = useState("");
  const [market, setMarket] = useState("");
  const [language, setLanguage] = useState("DE");
  // Bütçe hesabın para biriminde girilir (varsayılan EUR; eskiden "TL" yazıyordu).
  const [budget, setBudget] = useState("700");
  const [currency, setCurrency] = useState("EUR");
  const [duration, setDuration] = useState("14");
  const [targetLangs, setTargetLangs] = useState<string[]>([]);
  const [variations, setVariations] = useState("2");
  const [generating, setGenerating] = useState(false);
  const [results, setResults] = useState<LanguageResult[]>([]);
  const [overallRisk, setOverallRisk] = useState<string | null>(null);
  const [error, setError] = useState("");
  const langsLabelId = useId();
  async function load() {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await api<{ creatives: CreativeData[] }>("/api/creative");
      setCreatives(data.creatives ?? []);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "");
    }
    setLoading(false);
  }
  function toggle(list: string[], value: string, set: (v: string[]) => void) {
    set(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  }
  async function generate() {
    if (!name || !clinic || !service || !market) {
      setError("Kreatif adı, klinik, hizmet ve hedef pazar alanlarını doldurun.");
      return;
    }
    setError(""); setGenerating(true);
    try {
      // `api()` gövdeyi kendisi JSON'a çevirir; nesne verilir (önceki çift stringify hatası giderildi).
      const data = await api<GenerateResponse>("/api/creative", "POST", {
        name,
        brief: { clinic, service, market, language, budget: parseFloat(budget) || 0, duration: parseInt(duration) || 14 },
        languages: targetLangs,
        variations: parseInt(variations) || 2,
      });
      setResults(data.results ?? []);
      setOverallRisk(data.policy?.risk ?? null);
      setName(""); setClinic(""); setService(""); setMarket(""); setTargetLangs([]);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Kreatif üretilemedi. Birkaç dakika sonra tekrar deneyin.");
    }
    setGenerating(false);
  }
  useEffect(() => {
    load();
    void defaultAccountCurrency().then(setCurrency);
  }, []);
  const effectiveLangs = targetLangs.length > 0 ? targetLangs : [language];
  const overall = overallRisk ? policyRiskStyle(overallRisk) : null;
  return (
    <div className="space-y-8">
      <header className="studio-hero">
        <span className="eyebrow">KREATİF ÜRETİMİ</span>
        <h1>Kreatif üretimi</h1>
        <p>Brif bazlı, içerik kontrollü çok dilli kreatif üretimi; her dil için ayrı, yerelleştirilmiş üretim.</p>
      </header>
      <Card>
        <SectionHeading title="Yeni kreatif" description="Hedef, hedef kitle ve üslup bilgisiyle AI reklam metni üretir; içerik kontrolünden geçirir." />
        <div className="mt-6 space-y-4">
          <label className="field">
            Kreatif adı
            <input required value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="field">
              Klinik
              <input required value={clinic} onChange={(e) => setClinic(e.target.value)} />
            </label>
            <label className="field">
              Hizmet
              <input required placeholder="Örn. saç ekimi" value={service} onChange={(e) => setService(e.target.value)} />
            </label>
            <label className="field">
              Hedef pazar
              <input required placeholder="Örn. Almanya" value={market} onChange={(e) => setMarket(e.target.value)} />
            </label>
            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3">
              <label className="field">
                Varsayılan reklam dili
                <select value={language} onChange={(e) => setLanguage(e.target.value)}>
                  {BRIEF_LANGUAGES.map((l) => <option key={l} value={l} lang={l.toLowerCase()}>{LANG_LABEL[l]}</option>)}
                </select>
              </label>
              <label className="field">
                Varyant sayısı
                <select value={variations} onChange={(e) => setVariations(e.target.value)}>
                  {[2, 3, 4].map((v) => <option key={v} value={v}>{v} varyant</option>)}
                </select>
              </label>
            </div>
            <div role="group" aria-labelledby={langsLabelId}>
              <p id={langsLabelId} className="mb-2 text-xs font-semibold text-muted">Hedeflenen reklam dilleri</p>
              <div className="flex flex-wrap gap-1.5">
                {BRIEF_LANGUAGES.map((l) => {
                  const selected = targetLangs.includes(l);
                  return (
                    <button
                      key={l}
                      type="button"
                      lang={l.toLowerCase()}
                      aria-pressed={selected}
                      onClick={() => toggle(targetLangs, l, setTargetLangs)}
                      className={`inline-flex min-h-8 items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium ${selected ? "border-violet-600 bg-violet-50 text-violet-800" : "border-slate-300 text-slate-700 hover:bg-slate-50"}`}
                    >
                      {selected && <span aria-hidden="true">✓</span>}
                      {LANG_LABEL[l]}
                    </button>
                  );
                })}
              </div>
              <p className="mt-2 text-xs text-muted">
                Seçmezseniz varsayılan dilde üretilir; her dil için ayrı metin üretilir. {effectiveLangs.length} dil × {variations} varyant üretilecek.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-4 self-start">
              <label className="field">
                Toplam bütçe ({currency})
                <input type="number" min={1} value={budget} onChange={(e) => setBudget(e.target.value)} />
              </label>
              <label className="field">
                Süre (gün)
                <input type="number" min={1} max={90} value={duration} onChange={(e) => setDuration(e.target.value)} />
              </label>
            </div>
          </div>
          <button type="button" onClick={generate} disabled={generating} className="primary-button">{generating ? "Üretiliyor…" : "AI ile kreatif üret"}</button>
          {error && <p role="alert" className="text-sm text-rose-700">{error}</p>}
        </div>
      </Card>
      {results.length > 0 && (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <SectionHeading title="Önizleme" description="Dil başına üretilen varyantlar ve içerik kontrolü sonucu." />
            {overall && <Badge tone={overall.tone}>{overall.label}</Badge>}
          </div>
          <div className="mt-4 space-y-6">
            {results.map((r) => {
              const llm = r.policy.llm ?? null;
              const risk = policyRiskStyle(r.policy.risk);
              const lang = r.language.toLowerCase();
              return (
                <div key={r.language} className="rounded-xl border border-slate-200 p-5">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-slate-900">{languageName(r.language)}</p>
                    <Badge tone={risk.tone}>{risk.label}</Badge>
                  </div>
                  <div className="mt-3 grid gap-3 md:grid-cols-2">
                    {r.variants.map((v, i) => (
                      <div key={i} dir={rtlFor(r.language)} className="rounded-lg bg-slate-50 p-4">
                        <p className="text-xs text-muted">Varyant {String.fromCharCode(65 + i)}</p>
                        <p lang={lang} className="text-sm font-semibold text-slate-900">{v.headline}</p>
                        <p lang={lang} className="mt-2 text-sm text-slate-700">{v.text}</p>
                        {v.description && <p lang={lang} className="mt-1 text-xs text-muted">{v.description}</p>}
                        <p className="mt-3 text-xs text-violet-700">Eylem düğmesi: {ctaDisplay(v.cta)}</p>
                      </div>
                    ))}
                  </div>
                  {r.instantForm && (
                    <p className="mt-3 text-xs text-slate-700" dir={rtlFor(r.language)}>
                      <span className="font-medium">Anında Form soruları:</span> <span lang={lang}>{r.instantForm.questions.join(" · ")}</span>
                    </p>
                  )}
                  {r.whatsapp && (
                    <p className="mt-1 text-xs text-slate-700" dir={rtlFor(r.language)}>
                      <span className="font-medium">WhatsApp karşılama mesajı:</span> <span lang={lang}>{r.whatsapp.welcome}</span>
                    </p>
                  )}
                  {r.policy.findings && r.policy.findings.length > 0 && (
                    <div className="mt-4 space-y-2">
                      <p className="text-xs font-semibold text-muted">İçerik kontrolü bulguları</p>
                      {r.policy.findings.map((f, i) => (
                        <div
                          key={i}
                          className={`rounded-lg border p-3 text-xs ${f.risk === "HIGH" ? "border-rose-200 bg-rose-50 text-rose-900" : "border-amber-200 bg-amber-50 text-amber-900"}`}
                        >
                          <p className="font-medium">{f.risk ? policyRiskStyle(f.risk).label : "Bulgu"}</p>
                          <p className="mt-1">{f.reason}</p>
                          {f.suggestion && <p className="mt-0.5">Öneri: {f.suggestion}</p>}
                        </div>
                      ))}
                    </div>
                  )}
                  {llm && !llm.error && (
                    <div className="mt-3 rounded-lg border border-slate-200 p-3 text-xs text-slate-700">
                      <p>
                        <span className="font-medium">AI değerlendirmesi:</span> {llm.risk ? policyRiskStyle(llm.risk).label : "—"} — {llm.reason}
                      </p>
                      {llm.correctedCopy && (
                        <p className="mt-1" dir={rtlFor(r.language)}>
                          <span className="font-medium">Düzeltilmiş öneri:</span> <span lang={lang}>{llm.correctedCopy}</span>
                        </p>
                      )}
                    </div>
                  )}
                  {llm?.error && <p className="mt-3 text-xs text-amber-800">AI değerlendirmesi yapılamadı; karar kural kontrolüne göre verildi.</p>}
                </div>
              );
            })}
          </div>
        </Card>
      )}
      <Card>
        <SectionHeading title="Kreatifler" description="Son üretilen kreatifler ve durumları." />
        {loading ? (
          <div className="h-16 animate-pulse rounded-xl bg-slate-200/60" />
        ) : loadError !== null ? (
          <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
            <p className="font-medium">Kreatifler yüklenemedi.</p>
            {loadError && <p className="mt-1">{loadError}</p>}
            <button type="button" className="secondary-button mt-3" onClick={() => void load()}>
              Tekrar dene
            </button>
          </div>
        ) : creatives.length === 0 ? (
          <EmptyState message="Henüz kreatif yok. Yukarıdaki formla ilk kreatifinizi üretin." />
        ) : (
          <div className="space-y-3">
            {creatives.map((c) => {
              const status = creativeStatusStyle(c.status);
              const langs = (c.languages ?? []).map(languageName).join(", ");
              return (
                <div key={c.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 p-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-900">{c.name}</p>
                    <p className="text-xs text-muted">
                      {c.variations} varyant · {langs || "Dil belirtilmemiş"} · {policyRiskStyle(c.policyRisk).label}
                    </p>
                    {c.headline && <p className="mt-1 text-xs text-slate-700">{c.headline}</p>}
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge tone={status.tone}>{status.label}</Badge>
                    <span className="text-xs text-muted">{formatDay(c.createdAt)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

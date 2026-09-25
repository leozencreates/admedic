"use client";
import { useState, useEffect } from "react";
import { api } from "../_lib/client-api";
import { Badge, Card, EmptyState, SectionHeading } from "../_components/ui";
import { LANG_LABEL, BRIEF_LANGUAGES } from "../_lib/creative-lang";
type Tone = "green" | "amber" | "red" | "blue" | "violet" | "gray";
const STATUS_TONE: Record<string, Tone> = { DRAFT: "gray", IN_REVIEW: "amber", APPROVED: "green", PUBLISHED: "blue", REJECTED: "red", ACTIVE: "green", PAUSED: "amber" };
const RISK_TONE: Record<string, Tone> = { LOW: "green", MEDIUM: "amber", HIGH: "red" };
interface CreativeData { id: string; name: string; status: string; languages: string[]; variations: number; policyRisk: string | null; primaryText?: string; headline?: string; createdAt: string; }
interface Preview { headline: string; text: string; cta: string }
interface Finding { rule?: string; reason?: string; suggestion?: string; risk?: string }
interface PolicyView { risk: string; report?: { findings?: Finding[]; llm?: { risk?: string; reason?: string } } | null }
export default function CreativePage() {
  const [creatives, setCreatives] = useState<CreativeData[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [clinic, setClinic] = useState("");
  const [service, setService] = useState("");
  const [market, setMarket] = useState("");
  const [language, setLanguage] = useState("DE");
  const [budget, setBudget] = useState("25000");
  const [duration, setDuration] = useState("14");
  const [targetLangs, setTargetLangs] = useState<string[]>([]);
  const [variations, setVariations] = useState("2");
  const [generating, setGenerating] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [policy, setPolicy] = useState<PolicyView | null>(null);
  const [error, setError] = useState("");
  async function load() {
    setLoading(true);
    try { const data = await api<{ creatives: CreativeData[] }>("/api/creative"); setCreatives(data.creatives); } catch { setCreatives([]); }
    setLoading(false);
  }
  function toggle(list: string[], value: string, set: (v: string[]) => void) {
    set(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  }
  async function generate() {
    if (!name || !clinic || !service || !market) { setError("Kreatif adı, klinik, hizmet ve pazar zorunludur."); return; }
    setError(""); setGenerating(true);
    try {
      const data = await api<{ preview: Preview | null; policy: PolicyView | null }>("/api/creative", "POST", JSON.stringify({
        name,
        brief: { clinic, service, market, language, budget: parseFloat(budget) || 0, duration: parseInt(duration) || 14 },
        languages: targetLangs,
        variations: parseInt(variations) || 2,
      }));
      setPreview(data.preview);
      setPolicy(data.policy);
      setName(""); setClinic(""); setService(""); setMarket(""); setTargetLangs([]);
      load();
    } catch { setError("Üretim başarısız. AI anahtarı ayarlı mı kontrol edin."); }
    setGenerating(false);
  }
  useEffect(() => { load(); }, []);
  const policyKey = policy?.risk ?? "LOW";
  return (
    <div className="space-y-8">
      <header className="studio-hero">
        <span className="eyebrow">KREATİF ÜRETİMİ</span>
        <h1>Kreatif Üret</h1>
        <p className="text-sm text-slate-500">Brief bazlı, politika kontrollü çok dilli kreatif üretimi.</p>
      </header>
      <Card>
        <SectionHeading title="Yeni Kreatif" description="Hedef, dinleyici ve üslup bilgisiyle AI kopya üretir; içerik kontrolünden geçirir." />
        <div className="mt-6 space-y-4">
          <input placeholder="Kreatif adı" value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded-lg border border-slate-300 px-4 py-2 text-sm focus:border-violet-500 focus:ring-1 focus:ring-violet-400/30" />
          <div className="grid gap-4 sm:grid-cols-2">
            <input placeholder="Klinik" value={clinic} onChange={(e) => setClinic(e.target.value)} className="w-full rounded-lg border border-slate-300 px-4 py-2 text-sm" />
            <input placeholder="Hizmet (ör. Saç Ekimi)" value={service} onChange={(e) => setService(e.target.value)} className="w-full rounded-lg border border-slate-300 px-4 py-2 text-sm" />
            <input placeholder="Pazar (ör. Almanya)" value={market} onChange={(e) => setMarket(e.target.value)} className="w-full rounded-lg border border-slate-300 px-4 py-2 text-sm" />
            <div className="flex gap-2">
              <select value={language} onChange={(e) => setLanguage(e.target.value)} className="flex-1 rounded-lg border border-slate-300 px-4 py-2 text-sm">
                {BRIEF_LANGUAGES.map((l) => <option key={l} value={l}>{LANG_LABEL[l]}</option>)}
              </select>
              <select value={variations} onChange={(e) => setVariations(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
                {[2, 3, 4].map((v) => <option key={v} value={v}>{v} varyasyon</option>)}
              </select>
            </div>
            <div>
              <p className="mb-1.5 text-xs font-medium text-slate-500">Hedeflenen reklam dilleri</p>
              <div className="flex flex-wrap gap-1.5">
                {BRIEF_LANGUAGES.map((l) => (
                  <button key={l} onClick={() => toggle(targetLangs, l, setTargetLangs)} className={`rounded-full border px-3 py-1 text-xs font-medium ${targetLangs.includes(l) ? "border-emerald-500 bg-emerald-50 text-emerald-700" : "border-slate-300 text-slate-600 hover:bg-slate-50"}`}>{LANG_LABEL[l]}</button>
                ))}
              </div>
            </div>
            <div className="flex gap-4">
              <div>
                <p className="mb-1.5 text-xs font-medium text-slate-500">Bütçe (TL)</p>
                <input type="number" min={1} value={budget} onChange={(e) => setBudget(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
              </div>
              <div>
                <p className="mb-1.5 text-xs font-medium text-slate-500">Süre (gün)</p>
                <input type="number" min={1} max={90} value={duration} onChange={(e) => setDuration(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
              </div>
            </div>
          </div>
          <button onClick={generate} disabled={generating} className="primary-button disabled:opacity-60">{generating ? "Üretiliyor…" : "AI ile Kreatif Üret"}</button>
          {error && <p className="text-xs text-red-600">{error}</p>}
        </div>
      </Card>
      {preview && (
        <Card>
          <div className="flex items-center justify-between">
            <SectionHeading title="Önizleme" description="Üretilen birincil varyant" />
            <Badge tone={RISK_TONE[policyKey] ?? "gray"}>İçerik riski: {policyKey}</Badge>
          </div>
          <div className="mt-4 rounded-xl border border-slate-200 p-5">
            <p className="text-sm font-semibold text-slate-900">{preview.headline}</p>
            <p className="mt-2 text-sm text-slate-700">{preview.text}</p>
            <p className="mt-3 text-xs text-violet-600">CTA: {preview.cta}</p>
          </div>
          {policy?.report?.findings && policy.report.findings.length > 0 && (
            <div className="mt-4 space-y-2">
              <p className="text-xs font-medium text-slate-500">Politika bulguları</p>
              {policy.report.findings.map((f, i) => (
                <div key={i} className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
                  <p className="text-xs font-medium text-amber-800">{f.rule ?? "Bulgular"} · risk {f.risk ?? "-"}</p>
                  <p className="mt-1 text-xs text-amber-700">{f.reason}</p>
                  {f.suggestion && <p className="mt-0.5 text-xs text-amber-600">Öneri: {f.suggestion}</p>}
                </div>
              ))}
            </div>
          )}
          {policy?.report?.llm && (
            <p className="mt-3 text-xs text-slate-500">AI kontrolü: risk {policy.report.llm.risk} — {policy.report.llm.reason}</p>
          )}
        </Card>
      )}
      <Card>
        <SectionHeading title="Kreatifler" description="Üretilen kreatif varyasyonları." />
        {loading ? <div className="h-16 animate-pulse rounded-xl bg-slate-200/60" /> : creatives.length === 0 ? <EmptyState message="Henüz kreatif yok." /> : (
          <div className="space-y-3">
            {creatives.map((c) => (
              <div key={c.id} className="flex items-center justify-between rounded-lg border border-slate-200 p-3">
                <div>
                  <p className="text-sm font-medium text-slate-900">{c.name}</p>
                  <p className="text-xs text-slate-500">{c.variations} varyasyon · {(c.languages ?? []).map((l) => LANG_LABEL[l] ?? l).join(", ") || "-"}{c.policyRisk ? <span className="ml-2">İçerik riski: {c.policyRisk}</span> : null}</p>
                  {c.headline && <p className="mt-1 text-xs text-slate-600">{c.headline}</p>}
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={STATUS_TONE[c.status] ?? "gray"}>{c.status}</Badge>
                  <span className="text-xs text-slate-400">{new Date(c.createdAt).toLocaleDateString("tr-TR")}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
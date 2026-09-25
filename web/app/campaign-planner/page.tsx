"use client";
import { useState, useEffect } from "react";
import { api } from "../_lib/client-api";
import { Badge, Card, EmptyState, SectionHeading } from "../_components/ui";
import { PLANNER_MARKETS, marketLanguages } from "../_lib/campaign-plan";
import { BRIEF_LANGUAGES, LANG_LABEL } from "../_lib/creative-lang";
type Tone = "green" | "amber" | "red" | "blue" | "violet" | "gray";
const STATUS_TONE: Record<string, Tone> = { DRAFT: "gray", IN_REVIEW: "amber", APPROVED: "blue", ACTIVE: "green", PAUSED: "amber", REJECTED: "red", ARCHIVED: "gray", PUBLISHED_PAUSED: "violet" };
const OBJECTIVE_LABEL: Record<string, string> = { MAX_ROAS: "Maksimum ROAS", MAX_CONVERSIONS: "Maksimum Dönüşüm", MAX_IMPRESSIONS: "Maksimum Görüntüleme" };
const METHOD_LABEL: Record<string, string> = { landing_form: "Açılış Sayfası", whatsapp: "WhatsApp", instagram_dm: "Instagram DM" };
const MARKET_CODES = Object.keys(PLANNER_MARKETS);
interface CampaignData { id: string; name: string; status: string; workflowStatus: string; policyRisk: string | null; objective: string; budget: number; adSets: number; createdAt: string; metaCampaignId: string | null; rejectionReason: string | null; }
interface Plan { name: string; dailyBudgetCents: number; monthlyProjectedCents: number; structure: string; strategy: string; rationale: string; targetingRatione: string; blocked: boolean; blockingReasons: string[]; testPlan: { creativeVariations: number; testDurationDays: number; decisionMetric: string }; }
export default function CampaignPlannerPage() {
  const [campaigns, setCampaigns] = useState<CampaignData[]>([]);
  const [conns, setConns] = useState<{ id: string; status: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [brief, setBrief] = useState("");
  const [objective, setObjective] = useState("MAX_CONVERSIONS");
  const [budget, setBudget] = useState("");
  const [markets, setMarkets] = useState<string[]>([]);
  const [languages, setLanguages] = useState<string[]>([]);
  const [conversionMethod, setConversionMethod] = useState("landing_form");
  const [ageMin, setAgeMin] = useState("25");
  const [ageMax, setAgeMax] = useState("54");
  const [strategy, setStrategy] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  async function load() {
    setLoading(true);
    try { const data = await api<{ campaigns: CampaignData[] }>("/api/campaigns"); setCampaigns(data.campaigns); } catch { setCampaigns([]); }
    try { const c = await api<{ connections: { id: string; status: string }[] }>("/api/meta/connections"); setConns(c.connections ?? []); } catch { setConns([]); }
    setLoading(false);
  }
  function toggle(list: string[], value: string, set: (v: string[]) => void) {
    set(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  }
  function autoLanguages() {
    setLanguages(marketLanguages(markets));
  }
  async function buildPlan() {
    if (!budget || markets.length === 0) { setNotice("Günlük bütçe ve en az bir pazar seçin."); return; }
    setNotice(""); setPlanning(true);
    try {
      const data = await api<{ plan: Plan }>("/api/campaign-planner", "POST", JSON.stringify({
        objective,
        dailyBudgetCents: Math.round((parseFloat(budget) || 0) * 100),
        markets,
        languages: languages.length ? languages : undefined,
        conversionMethod,
        ageMin: ageMin ? parseInt(ageMin) : undefined,
        ageMax: ageMax ? parseInt(ageMax) : undefined,
        strategy: strategy || undefined,
        brief: brief || undefined,
      }));
      setPlan(data.plan);
      if (!name) setName(data.plan.name);
    } catch { setNotice("Plan üretilemedi. Girdileri kontrol edin."); }
    setPlanning(false);
  }
  async function saveDraft() {
    if (!plan) return;
    setSaving(true); setNotice("");
    try {
      await api("/api/campaigns", "POST", JSON.stringify({
        name,
        objective,
        budget: parseFloat(budget) || (plan.dailyBudgetCents / 100),
        markets,
        languages: languages.length ? languages : undefined,
        conversionMethod,
        ageMin: ageMin ? parseInt(ageMin) : undefined,
        ageMax: ageMax ? parseInt(ageMax) : undefined,
        strategy: strategy || plan.strategy,
        brief: brief || undefined,
      }));
      setPlan(null); setName(""); setBrief(""); setBudget(""); setMarkets([]); setLanguages([]);
      load();
    } catch { setNotice("Taslak kaydedilemedi (bütçe üst sınırı veya içerik kontrolü)."); }
    setSaving(false);
  }
  async function runAction(id: string, path: string, body?: object) {
    try { await api(`/api/campaigns/${id}/${path}`, "POST", JSON.stringify(body ?? {})); setNotice(""); load(); }
    catch { setNotice("İşlem tamamlanamadı. Yetki veya içerik kontrolünü kontrol edin."); }
  }
  useEffect(() => { load(); }, []);
  function actionsFor(c: CampaignData) {
    const w = c.workflowStatus;
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        {["DRAFT", "REJECTED"].includes(w) && <button onClick={() => runAction(c.id, "submit")} className="rounded-md border border-violet-200 px-2.5 py-1 text-xs font-medium text-violet-700 hover:bg-violet-50">Onaya Gönder</button>}
        {w === "IN_REVIEW" && <>
          <button onClick={() => runAction(c.id, "approve")} className="rounded-md border border-emerald-200 px-2.5 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50">Onayla</button>
          <button onClick={() => runAction(c.id, "reject", { reason: "İnceleme sonrası reddedildi." })} className="rounded-md border border-red-200 px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50">Reddet</button>
        </>}
        {w === "APPROVED" && <button onClick={() => runAction(c.id, "publish", { action: "PUBLISH" })} className="primary-button !px-2.5 !py-1 !text-xs">Yayınla</button>}
        {w === "PUBLISHED_PAUSED" && <>
          <button onClick={() => runAction(c.id, "publish", { action: "ACTIVATE" })} className="rounded-md border border-emerald-200 px-2.5 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50">Aktifleştir</button>
          <button onClick={() => runAction(c.id, "publish", { action: "ARCHIVE" })} className="rounded-md border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50">Arşivle</button>
        </>}
        {w === "ACTIVE" && <>
          <button onClick={() => runAction(c.id, "publish", { action: "PAUSE" })} className="rounded-md border border-amber-200 px-2.5 py-1 text-xs font-medium text-amber-700 hover:bg-amber-50">Duraklat</button>
          <button onClick={() => runAction(c.id, "publish", { action: "ARCHIVE" })} className="rounded-md border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50">Arşivle</button>
        </>}
      </div>
    );
  }
  return (
    <div className="space-y-8">
      <header className="studio-hero">
        <span className="eyebrow">KAMPANYA PLANLAYICI</span>
        <h1>Kampanya Taslak Oluştur</h1>
        <p className="text-sm text-slate-500">AI ajan pazarları, dilleri ve stratejiyi planlar; onaylanmadan yayınlanmaz.</p>
      </header>
      {conns.some((c) => c.status === "EXPIRED" || c.status === "REVOKED") && (
        <a href="/meta-connections" className="block rounded-xl border border-rose-300 bg-rose-50 p-3 text-sm text-rose-700 hover:bg-rose-100">
          Meta bağlantısı kesik. Kampanya işlemlerini sürdürmek için bağlantıları yenileyin →
        </a>
      )}
      <Card>
        <SectionHeading title="Hedef ve Kısıtlar" description="Doğal dilde hedef, pazar, dil ve içerik stratejisi." />
        <div className="mt-6 space-y-5">
          <textarea placeholder="Reklam hedefi (ör. Almanya'dan saç ekimi hedefleyen 30-50 yaş arası, uygun fiyat vurgusu)" value={brief} onChange={(e) => setBrief(e.target.value)} rows={3} className="w-full rounded-lg border border-slate-300 px-4 py-2 text-sm focus:border-violet-500 focus:ring-1 focus:ring-violet-400/30" />
          <div className="grid gap-4 sm:grid-cols-3">
            <select value={objective} onChange={(e) => setObjective(e.target.value)} className="rounded-lg border border-slate-300 px-4 py-2 text-sm">
              {Object.entries(OBJECTIVE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <input type="number" placeholder="Günlük bütçe (TL)" value={budget} onChange={(e) => setBudget(e.target.value)} className="rounded-lg border border-slate-300 px-4 py-2 text-sm" />
            <select value={conversionMethod} onChange={(e) => setConversionMethod(e.target.value)} className="rounded-lg border border-slate-300 px-4 py-2 text-sm">
              {Object.entries(METHOD_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <p className="mb-1.5 text-xs font-medium text-slate-500">Pazar (ülke)</p>
              <div className="flex flex-wrap gap-1.5">
                {MARKET_CODES.map((m) => (
                  <button key={m} onClick={() => toggle(markets, m, setMarkets)} className={`rounded-full border px-3 py-1 text-xs font-medium ${markets.includes(m) ? "border-violet-500 bg-violet-50 text-violet-700" : "border-slate-300 text-slate-600 hover:bg-slate-50"}`}>{PLANNER_MARKETS[m]}</button>
                ))}
              </div>
            </div>
            <div>
              <p className="mb-1.5 text-xs font-medium text-slate-500">Reklam dili <button onClick={autoLanguages} className="ml-2 text-violet-600 hover:underline">Pazardan otomatik</button></p>
              <div className="flex flex-wrap gap-1.5">
                {BRIEF_LANGUAGES.map((l) => (
                  <button key={l} onClick={() => toggle(languages, l, setLanguages)} className={`rounded-full border px-3 py-1 text-xs font-medium ${languages.includes(l) ? "border-emerald-500 bg-emerald-50 text-emerald-700" : "border-slate-300 text-slate-600 hover:bg-slate-50"}`}>{LANG_LABEL[l]}</button>
                ))}
              </div>
            </div>
            <div className="flex items-end gap-2">
              <div>
                <p className="mb-1.5 text-xs font-medium text-slate-500">Yaş aralığı</p>
                <div className="flex items-center gap-2">
                  <input type="number" min={18} max={64} placeholder="Min" value={ageMin} onChange={(e) => setAgeMin(e.target.value)} className="w-20 rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                  <span className="text-xs text-slate-400">–</span>
                  <input type="number" min={18} max={64} placeholder="Maks" value={ageMax} onChange={(e) => setAgeMax(e.target.value)} className="w-20 rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                </div>
              </div>
              <div className="ml-2">
                <p className="mb-1.5 text-xs font-medium text-slate-500">Bütçe stratejisi</p>
                <select value={strategy} onChange={(e) => setStrategy(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
                  <option value="">Otomatik</option>
                  <option value="CBO">CBO</option>
                  <option value="ABO">ABO</option>
                </select>
              </div>
            </div>
          </div>
          <button onClick={buildPlan} disabled={planning} className="primary-button disabled:opacity-60">{planning ? "Planlanıyor…" : "AI ile Taslak Oluştur"}</button>
          {notice && <p className="text-xs text-red-600">{notice}</p>}
        </div>
      </Card>
      {plan && (
        <Card>
          <SectionHeading title={`Plan: ${plan.name}`} description={`${OBJECTIVE_LABEL[objective]} · ${plan.dailyBudgetCents / 100} TL/gün · ${plan.strategy}`} />
          <div className="mt-4 space-y-4">
            {plan.blocked && (
              <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
                <p className="font-medium">Plan engellendi</p>
                <ul className="mt-1 list-inside list-disc text-xs">
                  {plan.blockingReasons.map((r) => <li key={r}>{r}</li>)}
                </ul>
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg border border-slate-200 p-3">
                <p className="text-xs font-medium text-slate-500">Yapı</p>
                <p className="mt-1 text-sm text-slate-800">{plan.structure}</p>
              </div>
              <div className="rounded-lg border border-slate-200 p-3">
                <p className="text-xs font-medium text-slate-500">Hedefleme</p>
                <p className="mt-1 text-sm text-slate-800">{plan.targetingRatione}</p>
              </div>
              <div className="sm:col-span-2 rounded-lg border border-slate-200 p-3">
                <p className="text-xs font-medium text-slate-500">Gerekçe</p>
                <p className="mt-1 text-sm text-slate-800">{plan.rationale}</p>
              </div>
              <div className="rounded-lg border border-slate-200 p-3">
                <p className="text-xs font-medium text-slate-500">Test planı</p>
                <p className="mt-1 text-sm text-slate-800">{plan.testPlan.creativeVariations} varyant · {plan.testPlan.testDurationDays} gün · karar metriği {plan.testPlan.decisionMetric}</p>
              </div>
              <div className="rounded-lg border border-slate-200 p-3">
                <p className="text-xs font-medium text-slate-500">Öngörülen aylık harcama</p>
                <p className="mt-1 text-sm font-semibold text-slate-800">{plan.monthlyProjectedCents / 100} TL</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <input placeholder="Taslak adı" value={name} onChange={(e) => setName(e.target.value)} className="flex-1 rounded-lg border border-slate-300 px-4 py-2 text-sm focus:border-violet-500 focus:ring-1 focus:ring-violet-400/30" />
              <button onClick={saveDraft} disabled={saving || plan.blocked} className="primary-button !bg-emerald-600 disabled:opacity-60">{saving ? "Kaydediliyor…" : "Taslağı Kaydet"}</button>
            </div>
          </div>
        </Card>
      )}
      <Card>
        <SectionHeading title="Taslaklar" description="Onaylanmamış kampanyalar." />
        {loading ? <div className="h-16 animate-pulse rounded-xl bg-slate-200/60" /> : campaigns.length === 0 ? <EmptyState message="Henüz kampanya taslağı yok." /> : (
          <div className="space-y-3">
            {campaigns.map((c) => (
              <div key={c.id} className="flex items-center justify-between rounded-lg border border-slate-200 p-3">
                <div>
                  <p className="text-sm font-medium text-slate-900">{c.name}{c.metaCampaignId ? <span className="ml-2 text-xs text-slate-400">Meta: {c.metaCampaignId}</span> : null}</p>
                  <p className="text-xs text-slate-500">{OBJECTIVE_LABEL[c.objective] ?? c.objective} · {c.adSets} ad set{c.policyRisk ? <span className="ml-2">İçerik riski: {c.policyRisk}</span> : null}</p>
                  {c.rejectionReason && <p className="text-xs text-red-600">Red gerekçesi: {c.rejectionReason}</p>}
                </div>
                <div className="flex items-center gap-2">
                  {actionsFor(c)}
                  <Badge tone={STATUS_TONE[c.workflowStatus] ?? "gray"}>{c.workflowStatus}</Badge>
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
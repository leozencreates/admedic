"use client";
import { useState, useEffect } from "react";
import { api } from "../_lib/client-api";
import { Badge, Card, EmptyState, SectionHeading } from "../_components/ui";
import { METHOD_LABEL, PLANNER_MARKETS, marketLanguages } from "../_lib/campaign-plan";
import type { PlanAdSet, PlanReasons } from "../_lib/campaign-plan";
import { BRIEF_LANGUAGES, LANG_LABEL } from "../_lib/creative-lang";
import { formatMoney } from "../_lib/format";
type Tone = "green" | "amber" | "red" | "blue" | "violet" | "gray";
const STATUS_TONE: Record<string, Tone> = { DRAFT: "gray", IN_REVIEW: "amber", APPROVED: "blue", ACTIVE: "green", PAUSED: "amber", REJECTED: "red", ARCHIVED: "gray", PUBLISHED_PAUSED: "violet" };
const OBJECTIVE_LABEL: Record<string, string> = { MAX_ROAS: "Maksimum ROAS", MAX_CONVERSIONS: "Maksimum Dönüşüm", MAX_IMPRESSIONS: "Maksimum Görüntüleme" };
const MARKET_CODES = Object.keys(PLANNER_MARKETS);
const SETTINGS_ROLES = ["OWNER", "ADMIN"];
/** Bütçeler minor unit (cent) gelir; gösterim `formatMoney(cents, currency)` ile yapılır. */
interface CampaignData { id: string; name: string; status: string; workflowStatus: string; policyRisk: string | null; objective: string; dailyBudget: number | null; budgetCents: number | null; currency: string; adSets: number; createdAt: string; metaCampaignId: string | null; rejectionReason: string | null; }
interface Plan { name: string; dailyBudgetCents: number; monthlyProjectedCents: number; currency: string; structure: string; strategy: string; rationale: string; targetingRationale: string; blocked: boolean; blockingReasons: string[]; testPlan: { creativeVariations: number; testDurationDays: number; decisionMetric: string }; adSets: PlanAdSet[]; reasons: PlanReasons; languages: string[]; }
interface OrgSettings { monthlyAdBudgetCapCents: number | null; monthlyAdBudgetCap: number | null; currency: string; }
interface ActionResult { campaign?: { policyWarning?: string | null; metaReviewStatus?: string } }
export default function CampaignPlannerPage() {
  const [campaigns, setCampaigns] = useState<CampaignData[]>([]);
  const [conns, setConns] = useState<{ id: string; status: string }[]>([]);
  const [role, setRole] = useState<string>("");
  const [settings, setSettings] = useState<OrgSettings | null>(null);
  const [capInput, setCapInput] = useState("");
  const [savingCap, setSavingCap] = useState(false);
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
  const [warning, setWarning] = useState("");
  const currency = settings?.currency ?? plan?.currency ?? campaigns[0]?.currency ?? "EUR";
  async function load() {
    setLoading(true);
    try { const data = await api<{ campaigns: CampaignData[] }>("/api/campaigns"); setCampaigns(data.campaigns); } catch { setCampaigns([]); }
    try { const c = await api<{ connections: { id: string; status: string }[] }>("/api/meta/connections"); setConns(c.connections ?? []); } catch { setConns([]); }
    try { const s = await api<{ actor: { role: string } | null }>("/api/session"); setRole(s.actor?.role ?? ""); } catch { setRole(""); }
    try {
      const o = await api<{ settings: OrgSettings }>("/api/org/settings");
      setSettings(o.settings);
      setCapInput(o.settings.monthlyAdBudgetCap == null ? "" : String(o.settings.monthlyAdBudgetCap));
    } catch { setSettings(null); }
    setLoading(false);
  }
  function toggle(list: string[], value: string, set: (v: string[]) => void) {
    set(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  }
  function autoLanguages() {
    setLanguages(marketLanguages(markets));
  }
  function showWarning(result: ActionResult | undefined) {
    const w = result?.campaign?.policyWarning;
    const review = result?.campaign?.metaReviewStatus;
    const parts = [
      w ? `Orta risk uyarısı: ${w}` : "",
      review === "DISAPPROVED" ? "Meta inceleme geri bildirimi: kampanya DISAPPROVED olarak işaretlendi." : "",
    ].filter(Boolean);
    setWarning(parts.join(" · "));
  }
  async function saveCap() {
    setSavingCap(true); setNotice("");
    try {
      const value = capInput.trim() === "" ? null : parseFloat(capInput);
      if (value != null && !(value > 0)) { setNotice("Aylık üst sınır pozitif bir tutar olmalı (boş bırakılırsa sınır kaldırılır)."); setSavingCap(false); return; }
      const o = await api<{ settings: OrgSettings }>("/api/org/settings", "PATCH", { monthlyAdBudgetCap: value });
      setSettings(o.settings);
      setCapInput(o.settings.monthlyAdBudgetCap == null ? "" : String(o.settings.monthlyAdBudgetCap));
    } catch (e) { setNotice((e as Error).message || "Aylık üst sınır kaydedilemedi."); }
    setSavingCap(false);
  }
  async function buildPlan() {
    if (!budget || markets.length === 0) { setNotice("Günlük bütçe ve en az bir pazar seçin."); return; }
    setNotice(""); setWarning(""); setPlanning(true);
    try {
      // `api()` gövdeyi kendisi JSON'a çevirir; düz nesne geçilir.
      const data = await api<{ plan: Plan }>("/api/campaign-planner", "POST", {
        objective,
        dailyBudgetCents: Math.round((parseFloat(budget) || 0) * 100),
        markets,
        languages: languages.length ? languages : undefined,
        conversionMethod,
        ageMin: ageMin ? parseInt(ageMin) : undefined,
        ageMax: ageMax ? parseInt(ageMax) : undefined,
        strategy: strategy || undefined,
        brief: brief || undefined,
      });
      setPlan(data.plan);
      if (!name) setName(data.plan.name);
    } catch (e) { setNotice((e as Error).message || "Plan üretilemedi. Girdileri kontrol edin."); }
    setPlanning(false);
  }
  async function saveDraft() {
    if (!plan) return;
    setSaving(true); setNotice("");
    try {
      // Bütçe major (insan) birim gönderilir; sunucu cent'e çevirir (ADR-0011).
      const result = await api<ActionResult>("/api/campaigns", "POST", {
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
      });
      showWarning(result);
      setPlan(null); setName(""); setBrief(""); setBudget(""); setMarkets([]); setLanguages([]);
      load();
    } catch (e) { setNotice((e as Error).message || "Taslak kaydedilemedi (bütçe üst sınırı veya içerik kontrolü)."); }
    setSaving(false);
  }
  async function runAction(id: string, path: string, body?: object) {
    try {
      const result = await api<ActionResult>(`/api/campaigns/${id}/${path}`, "POST", body ?? {});
      setNotice(""); showWarning(result); load();
    }
    catch (e) { setNotice((e as Error).message || "İşlem tamamlanamadı. Yetki veya içerik kontrolünü kontrol edin."); }
  }
  function rejectWithReason(id: string) {
    const reason = window.prompt("Red gerekçesi (en az 3 karakter):", "");
    if (reason == null) return;
    if (reason.trim().length < 3) { setNotice("Red gerekçesi en az 3 karakter olmalı."); return; }
    runAction(id, "reject", { reason: reason.trim() });
  }
  useEffect(() => { load(); }, []);
  function actionsFor(c: CampaignData) {
    const w = c.workflowStatus;
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        {["DRAFT", "REJECTED"].includes(w) && <button onClick={() => runAction(c.id, "submit")} className="rounded-md border border-violet-200 px-2.5 py-1 text-xs font-medium text-violet-700 hover:bg-violet-50">Onaya Gönder</button>}
        {w === "IN_REVIEW" && <>
          <button onClick={() => runAction(c.id, "approve")} className="rounded-md border border-emerald-200 px-2.5 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50">Onayla</button>
          <button onClick={() => rejectWithReason(c.id)} className="rounded-md border border-red-200 px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50">Reddet</button>
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
  const canEditCap = SETTINGS_ROLES.includes(role);
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
        <SectionHeading title="Aylık üst sınır" description={`Kuruluşun aylık reklam bütçesi üst sınırı (${currency}). Günlük bütçe × 30 bu sınırı aşan taslaklar bloklanır.`} />
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-slate-700">
            Geçerli sınır: <span className="font-semibold">{settings?.monthlyAdBudgetCapCents == null ? "tanımlı değil" : formatMoney(settings.monthlyAdBudgetCapCents, currency)}</span>
          </p>
          {canEditCap ? (
            <>
              <input type="number" min={0} step="0.01" placeholder={`Aylık üst sınır (${currency})`} value={capInput} onChange={(e) => setCapInput(e.target.value)} className="w-56 rounded-lg border border-slate-300 px-3 py-2 text-sm" />
              <button onClick={saveCap} disabled={savingCap} className="secondary-button disabled:opacity-60">{savingCap ? "Kaydediliyor…" : "Üst sınırı kaydet"}</button>
              <span className="text-xs text-slate-400">Boş bırakıp kaydederseniz sınır kaldırılır.</span>
            </>
          ) : (
            <span className="text-xs text-slate-400">Yalnızca OWNER/ADMIN düzenleyebilir.</span>
          )}
        </div>
      </Card>
      <Card>
        <SectionHeading title="Hedef ve Kısıtlar" description="Doğal dilde hedef, pazar, dil ve içerik stratejisi." />
        <div className="mt-6 space-y-5">
          <textarea placeholder="Reklam hedefi (ör. Almanya'dan saç ekimi hedefleyen 30-50 yaş arası, uygun fiyat vurgusu)" value={brief} onChange={(e) => setBrief(e.target.value)} rows={3} className="w-full rounded-lg border border-slate-300 px-4 py-2 text-sm focus:border-violet-500 focus:ring-1 focus:ring-violet-400/30" />
          <div className="grid gap-4 sm:grid-cols-3">
            <select value={objective} onChange={(e) => setObjective(e.target.value)} className="rounded-lg border border-slate-300 px-4 py-2 text-sm">
              {Object.entries(OBJECTIVE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <input type="number" min={0} step="0.01" placeholder={`Günlük bütçe (${currency})`} value={budget} onChange={(e) => setBudget(e.target.value)} className="rounded-lg border border-slate-300 px-4 py-2 text-sm" />
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
          {warning && <p className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-700">{warning}</p>}
        </div>
      </Card>
      {plan && (
        <Card>
          <SectionHeading title={`Plan: ${plan.name}`} description={`${OBJECTIVE_LABEL[objective]} · ${formatMoney(plan.dailyBudgetCents, plan.currency)}/gün · ${plan.strategy}`} />
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
                <p className="mt-1 text-xs text-slate-500">Neden: {plan.reasons.strategy}</p>
              </div>
              <div className="rounded-lg border border-slate-200 p-3">
                <p className="text-xs font-medium text-slate-500">Hedefleme</p>
                <p className="mt-1 text-sm text-slate-800">{plan.targetingRationale}</p>
              </div>
              <div className="rounded-lg border border-slate-200 p-3">
                <p className="text-xs font-medium text-slate-500">Objective</p>
                <p className="mt-1 text-sm text-slate-800">{OBJECTIVE_LABEL[objective]}</p>
                <p className="mt-1 text-xs text-slate-500">Neden: {plan.reasons.objective}</p>
              </div>
              <div className="rounded-lg border border-slate-200 p-3">
                <p className="text-xs font-medium text-slate-500">Dönüşüm yöntemi</p>
                <p className="mt-1 text-sm text-slate-800">{METHOD_LABEL[conversionMethod as keyof typeof METHOD_LABEL] ?? conversionMethod}</p>
                <p className="mt-1 text-xs text-slate-500">Neden: {plan.reasons.conversionMethod}</p>
              </div>
              <div className="rounded-lg border border-slate-200 p-3">
                <p className="text-xs font-medium text-slate-500">Test planı</p>
                <p className="mt-1 text-sm text-slate-800">{plan.testPlan.creativeVariations} varyasyon (1 kontrol + {plan.testPlan.creativeVariations - 1} varyant) · {plan.testPlan.testDurationDays} gün · karar metriği {plan.testPlan.decisionMetric}</p>
                <p className="mt-1 text-xs text-slate-500">Neden: {plan.reasons.testPlan}</p>
              </div>
              <div className="rounded-lg border border-slate-200 p-3">
                <p className="text-xs font-medium text-slate-500">Öngörülen aylık harcama</p>
                <p className="mt-1 text-sm font-semibold text-slate-800">{formatMoney(plan.monthlyProjectedCents, plan.currency)}</p>
                {settings?.monthlyAdBudgetCapCents != null && <p className="mt-1 text-xs text-slate-500">Kuruluş üst sınırı: {formatMoney(settings.monthlyAdBudgetCapCents, plan.currency)}</p>}
              </div>
              <div className="sm:col-span-2 rounded-lg border border-slate-200 p-3">
                <p className="text-xs font-medium text-slate-500">Ad set'ler (pazar/dil başına)</p>
                <ul className="mt-1 space-y-1 text-sm text-slate-800">
                  {plan.adSets.map((a) => (
                    <li key={a.market}>
                      <span className="font-medium">{a.name}</span>
                      <span className="ml-2 text-xs text-slate-500">
                        ülkeler {a.targeting.geo_locations.countries.join(", ") || "—"} · diller {a.targeting.locales.join(", ")} · {a.targeting.age_min}-{a.targeting.age_max} yaş · bütçe {a.dailyBudgetCents == null ? "kampanya seviyesinde (CBO)" : `${formatMoney(a.dailyBudgetCents, plan.currency)}/gün`}
                      </span>
                    </li>
                  ))}
                </ul>
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
                  <p className="text-xs text-slate-500">{OBJECTIVE_LABEL[c.objective] ?? c.objective} · {formatMoney(c.budgetCents ?? c.dailyBudget, c.currency)}/gün · {c.adSets} ad set{c.policyRisk ? <span className="ml-2">İçerik riski: {c.policyRisk}</span> : null}</p>
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

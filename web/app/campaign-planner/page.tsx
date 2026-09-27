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
const ROLE_LABEL: Record<string, string> = { OWNER: "Owner", ADMIN: "Admin", MEDIA_BUYER: "Medya satın alma", PATIENT_COORDINATOR: "Hasta koordinatörü", ANALYST: "Analist", VIEWER: "İzleyici" };
const MARKET_CODES = Object.keys(PLANNER_MARKETS);
const SETTINGS_ROLES = ["OWNER", "ADMIN"];
const EDIT_ROLES = ["OWNER", "ADMIN", "MEDIA_BUYER"];
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
/** Tam yayın uzun sürerse sunucu ilerlemeyi kaydedip IN_PROGRESS döner; istemci bu kadar tur devam ettirir. */
const MAX_PUBLISH_ROUNDS = 20;
interface ContentSummary { attachedAt: string; landingUrl: string | null; languages: string[]; drafts: { draftId: string; name: string; language: string; headlines: string[]; formQuestions: number }[]; }
interface Readiness { ready: boolean; reasons: string[]; warnings: string[]; }
interface ReviewSummary { status: string; checkedAt: string | null; disapproved: number; withIssues: number; pending: number; total: number | null; ads: { name: string; effectiveStatus: string | null; reasons: string[] }[]; }
const REVIEW_LABEL: Record<string, { text: string; tone: Tone }> = {
  DISAPPROVED: { text: "Meta reklam reddetti", tone: "red" },
  WITH_ISSUES: { text: "Meta: teslimat sorunu", tone: "amber" },
  PENDING_REVIEW: { text: "Meta incelemesinde", tone: "amber" },
  NO_ISSUES: { text: "Meta incelemesi: sorun yok", tone: "green" },
  UNKNOWN: { text: "Meta inceleme durumu bilinmiyor", tone: "gray" },
};
interface PublishProgress { status: "NOT_STARTED" | "IN_PROGRESS" | "COMPLETE" | "EXTERNAL"; campaignCreated: boolean; adSets: { total: number; published: number }; ads: { expected: number; published: number }; leadForms: number; creatives: number; lastError: { step: string; message: string; at: string } | null; }
/** Bütçeler minor unit (cent) gelir; gösterim `formatMoney(cents, currency)` ile yapılır. */
interface CampaignData {
  id: string; name: string; status: string; workflowStatus: string; policyRisk: string | null; objective: string;
  dailyBudget: number | null; budgetCents: number | null; currency: string; adSets: number; ads: number; createdAt: string;
  metaCampaignId: string | null; rejectionReason: string | null; imageHash: string | null; imageUrl: string | null;
  plan: { conversionMethod?: string; strategy?: string; languages?: string[] } | null;
  content: ContentSummary | null; readiness: Readiness | null; publish: PublishProgress;
  review: ReviewSummary | null;
}
interface Plan { name: string; dailyBudgetCents: number; monthlyProjectedCents: number; monthlyCommittedCents: number; currency: string; structure: string; strategy: string; rationale: string; targetingRationale: string; blocked: boolean; blockingReasons: string[]; testPlan: { creativeVariations: number; testDurationDays: number; decisionMetric: string }; adSets: PlanAdSet[]; reasons: PlanReasons; languages: string[]; }
interface OrgSettings { monthlyAdBudgetCapCents: number | null; monthlyAdBudgetCap: number | null; monthlyCommittedCents: number; currency: string; privacyPolicyUrl: string | null; }
interface Member { userId: string; email: string; name: string | null; role: string; status: string; isSelf: boolean; canApproveSpend: boolean; delegable: boolean; spendGrantedAt: string | null; spendGrantedBy: string | null; }
interface StudioDraftRow { id: string; name: string; status: string; content: { language?: string; service?: string; variants?: { headline?: string }[] } | null; }
interface ActionResult {
  campaign?: { policyWarning?: string | null; warnings?: string[] };
  publish?: { status: "COMPLETE" | "IN_PROGRESS"; progress: PublishProgress; warnings: string[] };
}
interface ContentEditor { campaignId: string; selected: string[]; landingUrl: string; }

function progressText(p: PublishProgress): string {
  return `ad set ${p.adSets.published}/${p.adSets.total} · reklam ${p.ads.published}/${p.ads.expected}${p.leadForms ? ` · lead formu ${p.leadForms}` : ""}`;
}
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Dosya okunamadı."));
    reader.readAsDataURL(file);
  });
}

export default function CampaignPlannerPage() {
  const [campaigns, setCampaigns] = useState<CampaignData[]>([]);
  const [conns, setConns] = useState<{ id: string; status: string }[]>([]);
  const [role, setRole] = useState<string>("");
  const [canApproveSpend, setCanApproveSpend] = useState(false);
  const [settings, setSettings] = useState<OrgSettings | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [canManageSpend, setCanManageSpend] = useState(false);
  const [approvedDrafts, setApprovedDrafts] = useState<StudioDraftRow[]>([]);
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
  const [planDraftIds, setPlanDraftIds] = useState<string[]>([]);
  const [planLandingUrl, setPlanLandingUrl] = useState("");
  const [planning, setPlanning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [warning, setWarning] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [liveProgress, setLiveProgress] = useState<Record<string, PublishProgress>>({});
  const [editor, setEditor] = useState<ContentEditor | null>(null);
  const currency = settings?.currency ?? plan?.currency ?? campaigns[0]?.currency ?? "EUR";
  async function load() {
    setLoading(true);
    try { const data = await api<{ campaigns: CampaignData[] }>("/api/campaigns"); setCampaigns(data.campaigns); } catch { setCampaigns([]); }
    try { const c = await api<{ connections: { id: string; status: string }[] }>("/api/meta/connections"); setConns(c.connections ?? []); } catch { setConns([]); }
    let currentRole = "";
    try {
      const s = await api<{ actor: { role: string; canApproveSpend?: boolean } | null }>("/api/session");
      currentRole = s.actor?.role ?? "";
      setRole(currentRole);
      setCanApproveSpend(Boolean(s.actor?.canApproveSpend));
    } catch { setRole(""); setCanApproveSpend(false); }
    try {
      const o = await api<{ settings: OrgSettings }>("/api/org/settings");
      setSettings(o.settings);
      setCapInput(o.settings.monthlyAdBudgetCap == null ? "" : String(o.settings.monthlyAdBudgetCap));
    } catch { setSettings(null); }
    if (SETTINGS_ROLES.includes(currentRole)) {
      try {
        const m = await api<{ members: Member[]; canManageSpendAuthority: boolean }>("/api/org/members");
        setMembers(m.members); setCanManageSpend(m.canManageSpendAuthority);
      } catch { setMembers([]); setCanManageSpend(false); }
    } else { setMembers([]); setCanManageSpend(false); }
    try {
      const d = await api<{ drafts: StudioDraftRow[] }>("/api/studio");
      setApprovedDrafts(d.drafts.filter((x) => x.status === "APPROVED"));
    } catch { setApprovedDrafts([]); }
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
    const parts = [
      w ? `Orta risk uyarısı: ${w}` : "",
      ...(result?.campaign?.warnings ?? []),
      ...(result?.publish?.warnings ?? []),
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
  async function setSpendAuthority(member: Member, granted: boolean) {
    setNotice("");
    try {
      await api(`/api/org/members/${member.userId}/spend-authority`, "PUT", { granted });
      load();
    } catch (e) { setNotice((e as Error).message || "Harcama yetkisi güncellenemedi."); }
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
        contentDraftIds: planDraftIds.length ? planDraftIds : undefined,
        landingUrl: planDraftIds.length && planLandingUrl.trim() ? planLandingUrl.trim() : undefined,
      });
      showWarning(result);
      setPlan(null); setName(""); setBrief(""); setBudget(""); setMarkets([]); setLanguages([]); setPlanDraftIds([]); setPlanLandingUrl("");
      load();
    } catch (e) { setNotice((e as Error).message || "Taslak kaydedilemedi (bütçe üst sınırı veya içerik kontrolü)."); }
    setSaving(false);
  }
  async function runAction(id: string, path: string, body?: object) {
    setBusy(id);
    try {
      const result = await api<ActionResult>(`/api/campaigns/${id}/${path}`, "POST", body ?? {});
      setNotice(""); showWarning(result); load();
    }
    catch (e) { setNotice((e as Error).message || "İşlem tamamlanamadı. Yetki veya içerik kontrolünü kontrol edin."); }
    setBusy(null);
  }
  /** Meta reklam incelemesini (effective_status + red gerekçeleri) şimdi yeniler. */
  async function refreshReview(id: string) {
    setBusy(id); setNotice("");
    try {
      const result = await api<{ campaigns: { status: string; newlyDisapproved: number; error?: string }[] }>(
        "/api/meta/review-sync",
        "POST",
        { campaignId: id },
      );
      const row = result.campaigns[0];
      if (row?.error) setNotice(`Meta incelemesi yenilenemedi: ${row.error}`);
      else if (row?.status === "NO_ADS") setNotice("Bu kampanyanın Meta'da yayınlanmış reklamı yok.");
      else if (row?.newlyDisapproved) setNotice(`Meta ${row.newlyDisapproved} reklamı reddetti; gerekçeler kampanya satırında ve uyarılarda.`);
      else setNotice("Meta inceleme durumu güncellendi.");
      load();
    } catch (e) { setNotice((e as Error).message || "Meta incelemesi yenilenemedi."); }
    setBusy(null);
  }
  /** Tam yayın: sunucu süre dolunca ilerlemeyi kaydeder; kalan adımlar için otomatik devam edilir. */
  async function publish(id: string) {
    setBusy(id); setNotice(""); setWarning("");
    try {
      for (let round = 0; round < MAX_PUBLISH_ROUNDS; round++) {
        const result = await api<ActionResult>(`/api/campaigns/${id}/publish`, "POST", { action: "PUBLISH" });
        showWarning(result);
        if (result.publish) setLiveProgress((prev) => ({ ...prev, [id]: result.publish!.progress }));
        if (result.publish?.status !== "IN_PROGRESS") break;
      }
    } catch (e) { setNotice((e as Error).message || "Yayın tamamlanamadı; tekrar 'Yayınla' ile kaldığı yerden devam edebilirsiniz."); }
    setBusy(null);
    load();
  }
  async function uploadImage(id: string, file: File | undefined) {
    if (!file) return;
    if (!["image/jpeg", "image/png"].includes(file.type)) { setNotice("Yalnızca JPEG veya PNG görsel yüklenebilir."); return; }
    if (file.size > MAX_IMAGE_BYTES) { setNotice("Görsel en fazla 3 MB olabilir."); return; }
    setBusy(id); setNotice("");
    try {
      const dataBase64 = await readAsDataUrl(file);
      const result = await api<ActionResult>(`/api/campaigns/${id}/image`, "POST", { filename: file.name, dataBase64 });
      showWarning(result);
      load();
    } catch (e) { setNotice((e as Error).message || "Görsel yüklenemedi."); }
    setBusy(null);
  }
  async function saveContent() {
    if (!editor) return;
    if (editor.selected.length === 0) { setNotice("En az bir onaylı taslak seçin."); return; }
    setBusy(editor.campaignId); setNotice("");
    try {
      const result = await api<ActionResult>(`/api/campaigns/${editor.campaignId}/content`, "PUT", {
        draftIds: editor.selected,
        landingUrl: editor.landingUrl.trim() ? editor.landingUrl.trim() : null,
      });
      showWarning(result);
      setEditor(null);
      load();
    } catch (e) { setNotice((e as Error).message || "İçerik bağlanamadı."); }
    setBusy(null);
  }
  function rejectWithReason(id: string) {
    const reason = window.prompt("Red gerekçesi (en az 3 karakter):", "");
    if (reason == null) return;
    if (reason.trim().length < 3) { setNotice("Red gerekçesi en az 3 karakter olmalı."); return; }
    runAction(id, "reject", { reason: reason.trim() });
  }
  useEffect(() => { load(); }, []);
  const canEdit = EDIT_ROLES.includes(role);
  function draftLabel(d: StudioDraftRow) {
    const lang = d.content?.language ?? "?";
    return `${d.name} · ${LANG_LABEL[lang] ?? lang}${d.content?.service ? ` · ${d.content.service}` : ""}`;
  }
  function draftPicker(selected: string[], onToggle: (id: string) => void, neededLanguages: string[]) {
    if (approvedDrafts.length === 0)
      return <p className="text-xs text-slate-500">Onaylı stüdyo taslağı yok. <a href="/studio" className="text-violet-600 hover:underline">Kreatif Stüdyo</a>'da taslak üretip onaylayın.</p>;
    return (
      <div className="space-y-1">
        {neededLanguages.length > 0 && <p className="text-xs text-slate-500">Planın dilleri: {neededLanguages.map((l) => LANG_LABEL[l] ?? l).join(", ")} — her pazar için en az bir dilde içerik gerekir.</p>}
        <div className="flex flex-wrap gap-1.5">
          {approvedDrafts.map((d) => {
            const lang = d.content?.language ?? "";
            const relevant = neededLanguages.length === 0 || neededLanguages.includes(lang);
            return (
              <button key={d.id} type="button" onClick={() => onToggle(d.id)} title={d.content?.variants?.map((v) => v.headline).filter(Boolean).join(" / ")}
                className={`rounded-full border px-3 py-1 text-xs font-medium ${selected.includes(d.id) ? "border-violet-500 bg-violet-50 text-violet-700" : relevant ? "border-slate-300 text-slate-700 hover:bg-slate-50" : "border-dashed border-slate-200 text-slate-400"}`}>
                {draftLabel(d)}
              </button>
            );
          })}
        </div>
      </div>
    );
  }
  function preparation(c: CampaignData) {
    const editable = ["DRAFT", "REJECTED"].includes(c.workflowStatus) && canEdit;
    const method = c.plan?.conversionMethod ?? "";
    const editing = editor?.campaignId === c.id;
    if (!c.plan || !["DRAFT", "REJECTED", "IN_REVIEW", "APPROVED"].includes(c.workflowStatus)) return null;
    return (
      <div className="mt-2 space-y-2 rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-slate-700">İçerik:</span>
          {c.content ? (
            <span>{c.content.drafts.map((d) => `${d.name} (${d.language})`).join(", ")}{c.content.landingUrl ? ` · ${c.content.landingUrl}` : ""}</span>
          ) : <span className="text-rose-600">bağlanmadı</span>}
          {editable && !editing && (
            <button type="button" onClick={() => setEditor({ campaignId: c.id, selected: c.content?.drafts.map((d) => d.draftId) ?? [], landingUrl: c.content?.landingUrl ?? "" })} className="text-violet-600 hover:underline">
              {c.content ? "Değiştir" : "Onaylı içerik seç"}
            </button>
          )}
        </div>
        {editing && editor && (
          <div className="space-y-2 rounded-md border border-slate-200 bg-white p-2">
            {draftPicker(editor.selected, (id) => setEditor({ ...editor, selected: editor.selected.includes(id) ? editor.selected.filter((x) => x !== id) : [...editor.selected, id] }), c.plan?.languages ?? [])}
            {method === "landing_form" && (
              <input type="url" placeholder="Açılış sayfası (https://…)" value={editor.landingUrl} onChange={(e) => setEditor({ ...editor, landingUrl: e.target.value })} className="w-full rounded-md border border-slate-300 px-2 py-1 text-xs" />
            )}
            <div className="flex gap-2">
              <button type="button" onClick={saveContent} disabled={busy === c.id} className="primary-button !px-2.5 !py-1 !text-xs disabled:opacity-60">İçeriği bağla</button>
              <button type="button" onClick={() => setEditor(null)} className="secondary-button !px-2.5 !py-1 !text-xs">Vazgeç</button>
            </div>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-slate-700">Görsel:</span>
          {c.imageHash ? (
            c.imageUrl ? <a href={c.imageUrl} target="_blank" rel="noreferrer" className="text-violet-600 hover:underline">yüklendi (önizle)</a> : <span>yüklendi ({c.imageHash.slice(0, 10)}…)</span>
          ) : <span className="text-rose-600">yüklenmedi</span>}
          {editable && (
            <label className="cursor-pointer text-violet-600 hover:underline">
              {c.imageHash ? "Değiştir" : "JPEG/PNG yükle (≤3 MB)"}
              <input type="file" accept="image/jpeg,image/png" className="hidden" disabled={busy === c.id} onChange={(e) => { uploadImage(c.id, e.target.files?.[0]); e.target.value = ""; }} />
            </label>
          )}
          {method && <span className="text-slate-400">· dönüşüm: {METHOD_LABEL[method as keyof typeof METHOD_LABEL] ?? method}</span>}
        </div>
        {c.readiness && c.readiness.reasons.length > 0 && (
          <ul className="list-inside list-disc text-rose-600">{c.readiness.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
        )}
        {c.readiness && c.readiness.warnings.length > 0 && (
          <ul className="list-inside list-disc text-amber-700">{c.readiness.warnings.map((r) => <li key={r}>{r}</li>)}</ul>
        )}
        {c.readiness?.ready && <p className="text-emerald-700">Meta'ya eksiksiz yayına hazır.</p>}
      </div>
    );
  }
  function actionsFor(c: CampaignData) {
    const w = c.workflowStatus;
    const isBusy = busy === c.id;
    const progress = liveProgress[c.id] ?? c.publish;
    const partial = w === "APPROVED" && progress.status === "IN_PROGRESS";
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        {["DRAFT", "REJECTED"].includes(w) && <button disabled={isBusy} onClick={() => runAction(c.id, "submit")} className="rounded-md border border-violet-200 px-2.5 py-1 text-xs font-medium text-violet-700 hover:bg-violet-50 disabled:opacity-60">Onaya Gönder</button>}
        {w === "IN_REVIEW" && <>
          <button disabled={isBusy} onClick={() => runAction(c.id, "approve")} className="rounded-md border border-emerald-200 px-2.5 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-60">Onayla</button>
          <button disabled={isBusy} onClick={() => rejectWithReason(c.id)} className="rounded-md border border-red-200 px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-60">Reddet</button>
        </>}
        {w === "APPROVED" && <button disabled={isBusy} onClick={() => publish(c.id)} className="primary-button !px-2.5 !py-1 !text-xs disabled:opacity-60">{isBusy ? "Yayınlanıyor…" : partial ? "Yayına devam et" : "Yayınla (PAUSED)"}</button>}
        {partial && !isBusy && <button onClick={() => runAction(c.id, "publish", { action: "ARCHIVE" })} className="rounded-md border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50">Arşivle</button>}
        {w === "PUBLISHED_PAUSED" && <>
          <button disabled={isBusy || !canApproveSpend} title={canApproveSpend ? "Harcamayı başlatır" : "Harcama yetkisi gerekli (Owner veya yetki verilen üye)"} onClick={() => runAction(c.id, "publish", { action: "ACTIVATE" })} className="rounded-md border border-emerald-200 px-2.5 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50">Aktifleştir</button>
          <button disabled={isBusy} onClick={() => runAction(c.id, "publish", { action: "ARCHIVE" })} className="rounded-md border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-60">Arşivle</button>
        </>}
        {w === "ACTIVE" && <>
          <button disabled={isBusy} onClick={() => runAction(c.id, "publish", { action: "PAUSE" })} className="rounded-md border border-amber-200 px-2.5 py-1 text-xs font-medium text-amber-700 hover:bg-amber-50 disabled:opacity-60">Duraklat</button>
          <button disabled={isBusy} onClick={() => runAction(c.id, "publish", { action: "ARCHIVE" })} className="rounded-md border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-60">Arşivle</button>
        </>}
        {["PUBLISHED_PAUSED", "ACTIVE"].includes(w) && c.ads > 0 && (
          <button disabled={isBusy} onClick={() => refreshReview(c.id)} title="Reklamların Meta inceleme durumunu ve red gerekçelerini şimdi okur" className="rounded-md border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-60">İncelemeyi yenile</button>
        )}
      </div>
    );
  }
  const canEditCap = SETTINGS_ROLES.includes(role);
  const capCents = settings?.monthlyAdBudgetCapCents ?? null;
  const committedCents = settings?.monthlyCommittedCents ?? 0;
  const delegableMembers = members.filter((m) => m.role !== "OWNER");
  return (
    <div className="space-y-8">
      <header className="studio-hero">
        <span className="eyebrow">KAMPANYA PLANLAYICI</span>
        <h1>Kampanya Taslak Oluştur</h1>
        <p className="text-sm text-slate-500">AI ajan pazarları, dilleri ve stratejiyi planlar; onaylanmadan yayınlanmaz, Meta'da PAUSED kurulur ve yalnızca harcama yetkisi olan kişi etkinleştirir.</p>
      </header>
      {conns.some((c) => c.status === "EXPIRED" || c.status === "REVOKED") && (
        <a href="/meta-connections" className="block rounded-xl border border-rose-300 bg-rose-50 p-3 text-sm text-rose-700 hover:bg-rose-100">
          Meta bağlantısı kesik. Kampanya işlemlerini sürdürmek için bağlantıları yenileyin →
        </a>
      )}
      <Card>
        <SectionHeading title="Aylık üst sınır" description={`Kuruluşun aylık reklam bütçesi üst sınırı (${currency}). Aktif kampanyaların aylık toplamı + yeni/artan bütçe × 30 bu sınırı aşarsa işlem bloklanır.`} />
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-slate-700">
            Geçerli sınır: <span className="font-semibold">{capCents == null ? "tanımlı değil" : formatMoney(capCents, currency)}</span>
            <span className="ml-3 text-slate-500">Aktif kampanyalar: {formatMoney(committedCents, currency)}/ay</span>
            {capCents != null && <span className="ml-3 text-slate-500">Kalan: {formatMoney(Math.max(0, capCents - committedCents), currency)}/ay</span>}
          </p>
          {canEditCap ? (
            <>
              <input type="number" min={0} step="0.01" placeholder={`Aylık üst sınır (${currency})`} value={capInput} onChange={(e) => setCapInput(e.target.value)} className="w-56 rounded-lg border border-slate-300 px-3 py-2 text-sm" />
              <button onClick={saveCap} disabled={savingCap} className="secondary-button disabled:opacity-60">{savingCap ? "Kaydediliyor…" : "Üst sınırı kaydet"}</button>
              <span className="text-xs text-slate-400">Düşürme OWNER/ADMIN; yükseltme veya kaldırma (boş bırakıp kaydetme) yalnızca Owner.</span>
            </>
          ) : (
            <span className="text-xs text-slate-400">Yalnızca OWNER/ADMIN düzenleyebilir.</span>
          )}
        </div>
      </Card>
      {SETTINGS_ROLES.includes(role) && (
        <Card>
          <SectionHeading title="Harcama yetkisi" description="Kampanyayı etkinleştirmek ve bütçe artırmak yalnızca Owner'a veya Owner'ın yetki verdiği ADMIN/MEDIA_BUYER üyeye açıktır. Her değişiklik denetim kaydına yazılır." />
          {delegableMembers.length === 0 ? <EmptyState message="Yetki verilebilecek başka üye yok." /> : (
            <div className="space-y-2">
              {delegableMembers.map((m) => (
                <div key={m.userId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 p-2.5 text-sm">
                  <div>
                    <span className="font-medium text-slate-800">{m.name ?? m.email}</span>
                    <span className="ml-2 text-xs text-slate-500">{m.email} · {ROLE_LABEL[m.role] ?? m.role}{m.status !== "ACTIVE" ? ` · ${m.status}` : ""}</span>
                    {m.canApproveSpend && m.spendGrantedAt && <span className="ml-2 text-xs text-slate-400">yetki {new Date(m.spendGrantedAt).toLocaleDateString("tr-TR")}{m.spendGrantedBy ? ` (${m.spendGrantedBy})` : ""}</span>}
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge tone={m.canApproveSpend ? "green" : "gray"}>{m.canApproveSpend ? "Harcama yetkili" : "Yetkisiz"}</Badge>
                    {canManageSpend && m.delegable && (
                      <button onClick={() => setSpendAuthority(m, !m.canApproveSpend)} className="rounded-md border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50">
                        {m.canApproveSpend ? "Yetkiyi geri al" : "Yetki ver"}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          {!canManageSpend && <p className="mt-2 text-xs text-slate-400">Yetkiyi yalnızca Owner verebilir veya geri alabilir.</p>}
        </Card>
      )}
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
                {plan.monthlyCommittedCents > 0 && <p className="mt-1 text-xs text-slate-500">Aktif kampanyalar: {formatMoney(plan.monthlyCommittedCents, plan.currency)}/ay</p>}
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
                <p className="mt-2 text-xs text-slate-400">Yayında her ad set, içeriği olan dil başına ayrı Meta ad set'i olarak kurulur (reklam dili = hedeflenen dil).</p>
              </div>
              <div className="sm:col-span-2 rounded-lg border border-slate-200 p-3">
                <p className="mb-1 text-xs font-medium text-slate-500">Reklam içeriği (isteğe bağlı; sonradan da seçilebilir)</p>
                {draftPicker(planDraftIds, (id) => setPlanDraftIds(planDraftIds.includes(id) ? planDraftIds.filter((x) => x !== id) : [...planDraftIds, id]), plan.languages)}
                {conversionMethod === "landing_form" && planDraftIds.length > 0 && (
                  <input type="url" placeholder="Açılış sayfası (https://…)" value={planLandingUrl} onChange={(e) => setPlanLandingUrl(e.target.value)} className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm" />
                )}
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
        <SectionHeading title="Kampanyalar" description="Onay → Meta'da PAUSED eksiksiz yayın (kampanya, ad set, kreatif, reklam) → yetkili etkinleştirme." />
        {loading ? <div className="h-16 animate-pulse rounded-xl bg-slate-200/60" /> : campaigns.length === 0 ? <EmptyState message="Henüz kampanya taslağı yok." /> : (
          <div className="space-y-3">
            {campaigns.map((c) => {
              const progress = liveProgress[c.id] ?? c.publish;
              return (
                <div key={c.id} className="rounded-lg border border-slate-200 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-medium text-slate-900">{c.name}{c.metaCampaignId ? <span className="ml-2 text-xs text-slate-400">Meta: {c.metaCampaignId}</span> : null}</p>
                      <p className="text-xs text-slate-500">{OBJECTIVE_LABEL[c.objective] ?? c.objective} · {formatMoney(c.budgetCents ?? c.dailyBudget, c.currency)}/gün · {c.adSets} ad set{c.ads ? ` · ${c.ads} reklam` : ""}{c.policyRisk ? <span className="ml-2">İçerik riski: {c.policyRisk}</span> : null}</p>
                      {c.rejectionReason && <p className="text-xs text-red-600">Red gerekçesi: {c.rejectionReason}</p>}
                      {(progress.status === "IN_PROGRESS" || (busy === c.id && c.workflowStatus === "APPROVED")) && (
                        <p className="text-xs text-violet-700">Meta yayını: {progressText(progress)}</p>
                      )}
                      {progress.lastError && c.workflowStatus === "APPROVED" && (
                        <p className="text-xs text-rose-600">Son hata ({progress.lastError.step}): {progress.lastError.message}</p>
                      )}
                      {c.review && (
                        <div className="mt-1 space-y-1 text-xs">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge tone={REVIEW_LABEL[c.review.status]?.tone ?? "gray"}>{REVIEW_LABEL[c.review.status]?.text ?? c.review.status}</Badge>
                            {(c.review.disapproved > 0 || c.review.withIssues > 0 || c.review.pending > 0) && (
                              <span className="text-slate-500">
                                {[
                                  c.review.disapproved ? `${c.review.disapproved} reddedildi` : "",
                                  c.review.withIssues ? `${c.review.withIssues} sorunlu` : "",
                                  c.review.pending ? `${c.review.pending} incelemede` : "",
                                ].filter(Boolean).join(" · ")}
                                {c.review.total ? ` / ${c.review.total} reklam` : ""}
                              </span>
                            )}
                            {c.review.checkedAt && <span className="text-slate-400">{new Date(c.review.checkedAt).toLocaleString("tr-TR")}</span>}
                          </div>
                          {c.review.ads.length > 0 && (
                            <ul className="list-inside list-disc text-rose-700">
                              {c.review.ads.map((ad, i) => (
                                <li key={`${ad.name}-${i}`}>{ad.name || "Reklam"}{ad.effectiveStatus ? ` (${ad.effectiveStatus})` : ""}: {ad.reasons.length ? ad.reasons.join("; ") : "Meta gerekçe bildirmedi."}</li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      {actionsFor(c)}
                      <Badge tone={STATUS_TONE[c.workflowStatus] ?? "gray"}>{c.workflowStatus}</Badge>
                      <span className="text-xs text-slate-400">{new Date(c.createdAt).toLocaleDateString("tr-TR")}</span>
                    </div>
                  </div>
                  {preparation(c)}
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

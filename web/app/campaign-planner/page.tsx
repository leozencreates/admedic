"use client";
import Link from "next/link";
import { useEffect, useId, useState, type ReactNode } from "react";
import { api } from "../_lib/client-api";
import { Badge, Card, EmptyState, PageHeader, SectionHeading } from "../_components/ui";
import { ConfirmDialog, Dialog } from "../_components/dialog";
import { StageBar } from "../_components/stage-bar";
import { campaignStage } from "../_lib/stages";
import { METHOD_LABEL, OBJECTIVE_LABEL, PLANNER_MARKETS, marketLanguages } from "../_lib/campaign-plan";
import type { PlanAdSet, PlanReasons } from "../_lib/campaign-plan";
import { BRIEF_LANGUAGES } from "../_lib/creative-lang";
import { formatDate, formatDay, formatMoney } from "../_lib/format";
import {
  adEffectiveStatusStyle,
  budgetModeLabel,
  countryName,
  languageName,
  membershipStatusLabel,
  metaReviewStyle,
  objectiveLabel,
  policyRiskStyle,
  publishStepLabel,
  roleLabel,
} from "../_lib/labels";

const MARKET_CODES = Object.keys(PLANNER_MARKETS);
const SETTINGS_ROLES = ["OWNER", "ADMIN"];
/** İçerik, yükleme, duraklatma ve arşivleme (sunucudaki `EDIT_ROLES`). */
const EDIT_ROLES = ["OWNER", "ADMIN", "MEDIA_BUYER"];
/** Onaylama ve düzeltme isteme (sunucudaki `approve` / `reject` uçlarıyla aynı roller). */
const APPROVER_ROLES = ["OWNER", "ADMIN"];
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
/** Tam yükleme uzun sürerse sunucu ilerlemeyi kaydedip IN_PROGRESS döner; istemci bu kadar tur devam ettirir. */
const MAX_PUBLISH_ROUNDS = 20;
/** Aylık tahmin: günlük bütçe × 30 (sunucudaki `MONTH_DAYS`). */
const MONTH_DAYS = 30;
const REJECT_REASON_MIN = 3;
const REJECT_REASON_MAX = 500;
/** `?focus=<id>` ile açılan kampanya satırının vurgulu kalma süresi. */
const HIGHLIGHT_MS = 3000;

const BTN_PRIMARY = "primary-button min-h-9 px-3 py-1.5 text-xs";
const BTN_SECONDARY = "secondary-button min-h-9 px-3 py-1.5 text-xs";
const LINK_TEXT = "font-medium text-violet-700 underline-offset-2 hover:underline";

interface ContentSummary { attachedAt: string; landingUrl: string | null; languages: string[]; drafts: { draftId: string; name: string; language: string; headlines: string[]; formQuestions: number }[]; }
interface Readiness { ready: boolean; reasons: string[]; warnings: string[]; }
interface ReviewSummary { status: string; checkedAt: string | null; disapproved: number; withIssues: number; pending: number; total: number | null; ads: { name: string; effectiveStatus: string | null; reasons: string[] }[]; }
interface PublishProgress { status: "NOT_STARTED" | "IN_PROGRESS" | "COMPLETE" | "EXTERNAL"; campaignCreated: boolean; adSets: { total: number; published: number }; ads: { expected: number; published: number }; leadForms: number; creatives: number; lastError: { step: string; message: string; at: string } | null; }
/** Bütçeler minor unit (cent) gelir; `status` Meta'daki durum, `workflowStatus` onay/yayın akışıdır. */
interface CampaignData {
  id: string; name: string; status: string; workflowStatus: string; policyRisk: string | null; objective: string | null;
  dailyBudget: number | null; budgetCents: number | null; currency: string | null; adSets: number; ads: number; createdAt: string;
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
  campaign?: { id?: string; name?: string; policyWarning?: string | null; warnings?: string[] };
  publish?: { status: "COMPLETE" | "IN_PROGRESS"; progress: PublishProgress; warnings: string[] };
}
interface ContentEditor { campaignId: string; selected: string[]; landingUrl: string; }

type NoteTone = "success" | "warning" | "error";
/** Satır/kart içi sonuç mesajı; `link` başarı mesajından ilgili yere götürür. */
interface Note { tone: NoteTone; text: string; link?: { href: string; label: string; onClick?: () => void } }
/** Satırda süren işlem (tıklanan düğme "…iliyor" metnini gösterir). */
type RowAction = "submit" | "approve" | "reject" | "publish" | "activate" | "pause" | "archive" | "review" | "image" | "content";
interface ConfirmState { id: string; busy: boolean; error: string }
interface RejectState { id: string; reason: string; fieldError: string; error: string; busy: boolean }

const NOTE_CLASS: Record<NoteTone, string> = {
  success: "rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800",
  warning: "rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900",
  error: "rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800",
};

/** Kuruşlu tutar 2 ondalıkla gösterilir: harcama onayında yuvarlanmış bütçe yazılmaz ("€12,50", "€500"). */
function money(cents: number | null | undefined, currency: string | null | undefined): string {
  return formatMoney(cents, currency ?? null, { precise: cents != null && !Number.isInteger(cents / 100) });
}
function dailyBudgetCents(c: CampaignData): number | null {
  return c.budgetCents ?? c.dailyBudget ?? null;
}
/** Planlayıcı hedefi (MAX_*) ya da Meta'dan gelen hedef (OUTCOME_*) → kampanya hedefi adı. */
function campaignObjectiveName(objective: string | null | undefined): string | null {
  if (!objective) return null;
  return (OBJECTIVE_LABEL as Record<string, string>)[objective] ?? objectiveLabel(objective);
}
function methodName(method: string | null | undefined): string {
  if (!method) return "—";
  return (METHOD_LABEL as Record<string, string>)[method] ?? "Bilinmeyen yöntem";
}
function languagesText(codes: readonly string[]): string {
  return codes.length ? codes.map((code) => languageName(code)).join(", ") : "—";
}
function countriesText(codes: readonly string[]): string {
  return codes.length ? codes.map((code) => countryName(code)).join(", ") : "—";
}
function progressText(p: PublishProgress): string {
  const parts = [`reklam seti ${p.adSets.published}/${p.adSets.total}`, `reklam ${p.ads.published}/${p.ads.expected}`];
  if (p.leadForms) parts.push(`Anında Form ${p.leadForms}`);
  return parts.join(" · ");
}
/** Sunucunun Türkçe hata metni; yanıt JSON değilse ya da ağ yoksa anlaşılır bir metin. */
function errorText(e: unknown, fallback: string): string {
  if (e instanceof SyntaxError) return fallback;
  if (e instanceof TypeError) return "Sunucuya ulaşılamadı. Bağlantınızı kontrol edip tekrar deneyin.";
  return e instanceof Error && e.message ? e.message : fallback;
}
/** İşlem yanıtındaki uyarılar (orta risk, içerik, yükleme) satırda sarı not olarak gösterilir. */
function warningNotes(result: ActionResult | undefined): Note[] {
  const policy = result?.campaign?.policyWarning;
  return [
    ...(policy ? [`İçerik kontrolü: orta risk. ${policy}`] : []),
    ...(result?.campaign?.warnings ?? []),
    ...(result?.publish?.warnings ?? []),
  ]
    .filter(Boolean)
    .map((text) => ({ tone: "warning" as const, text }));
}
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Dosya okunamadı."));
    reader.readAsDataURL(file);
  });
}

/**
 * Sonuç mesajları (EM-5): başarı ve uyarı kibar (`status`), hata hemen (`alert`) duyurulur. Her iki
 * canlı bölge de DOM'da hep durur ki içerik eklendiğinde ekran okuyucu okusun.
 */
function Feedback({ notes, id, className = "mt-2" }: { notes: Note[]; id?: string; className?: string }) {
  const errors = notes.filter((n) => n.tone === "error");
  const others = notes.filter((n) => n.tone !== "error");
  const render = (n: Note, i: number) => (
    <p key={`${n.tone}-${i}`} className={NOTE_CLASS[n.tone]}>
      {n.text}
      {n.link ? (
        <>
          {" "}
          <a href={n.link.href} onClick={n.link.onClick} className="font-semibold underline underline-offset-2">
            {n.link.label}
          </a>
        </>
      ) : null}
    </p>
  );
  return (
    <div id={id} tabIndex={id ? -1 : undefined} className={notes.length ? className : undefined}>
      <div role="status" aria-live="polite" className="space-y-1.5">
        {others.map(render)}
      </div>
      <div role="alert" className={others.length && errors.length ? "mt-1.5 space-y-1.5" : "space-y-1.5"}>
        {errors.map(render)}
      </div>
    </div>
  );
}

/** Seçim çipi: seçili durum `aria-pressed` ve görünür ✓ ile de bildirilir (yalnızca renkle değil). */
function Chip({
  selected,
  onClick,
  children,
  muted = false,
  title,
}: {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
  muted?: boolean;
  title?: string;
}) {
  const tone = selected
    ? "border-brand bg-violet-50 text-violet-800"
    : muted
      ? "border-dashed border-slate-300 text-muted hover:bg-slate-50"
      : "border-slate-300 text-slate-700 hover:bg-slate-50";
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      title={title}
      className={`inline-flex min-h-8 items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium ${tone}`}
    >
      {selected ? <span aria-hidden="true">✓</span> : null}
      {children}
    </button>
  );
}

function PlanBox({
  title,
  titleId,
  reason,
  className = "",
  children,
}: {
  title: string;
  titleId?: string;
  reason?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`rounded-lg border border-slate-200 p-3 ${className}`}>
      <h3 id={titleId} className="text-xs font-medium text-muted">
        {title}
      </h3>
      <div className="mt-1 text-sm text-slate-800">{children}</div>
      {reason ? <p className="mt-1 text-xs text-muted">Neden: {reason}</p> : null}
    </div>
  );
}

export default function CampaignPlannerPage() {
  const [campaigns, setCampaigns] = useState<CampaignData[]>([]);
  const [campaignsError, setCampaignsError] = useState(false);
  const [conns, setConns] = useState<{ id: string; status: string }[]>([]);
  const [role, setRole] = useState<string>("");
  const [canApproveSpend, setCanApproveSpend] = useState(false);
  const [settings, setSettings] = useState<OrgSettings | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [canManageSpend, setCanManageSpend] = useState(false);
  const [approvedDrafts, setApprovedDrafts] = useState<StudioDraftRow[]>([]);
  const [capInput, setCapInput] = useState("");
  const [savingCap, setSavingCap] = useState(false);
  const [capNote, setCapNote] = useState<Note | null>(null);
  const [authorityBusy, setAuthorityBusy] = useState<string | null>(null);
  const [authorityNote, setAuthorityNote] = useState<Note | null>(null);
  /** Yalnızca ilk yükleme iskelet gösterir; işlem sonrası yenilemede liste yerinde kalır. */
  const [loading, setLoading] = useState(true);
  const [reloading, setReloading] = useState(false);
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
  const [formNotes, setFormNotes] = useState<Note[]>([]);
  const [saveError, setSaveError] = useState("");
  const [busy, setBusy] = useState<Record<string, RowAction>>({});
  const [rowNotes, setRowNotes] = useState<Record<string, Note[]>>({});
  const [liveProgress, setLiveProgress] = useState<Record<string, PublishProgress>>({});
  const [editor, setEditor] = useState<ContentEditor | null>(null);
  const [activation, setActivation] = useState<ConfirmState | null>(null);
  const [archiving, setArchiving] = useState<ConfirmState | null>(null);
  const [rejecting, setRejecting] = useState<RejectState | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [focusMissing, setFocusMissing] = useState(false);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const marketsLabelId = useId();
  const languagesLabelId = useId();
  const planDraftsLabelId = useId();
  const capHintId = useId();
  const rejectFieldId = useId();
  const rejectHintId = useId();
  const rejectErrorId = useId();
  const currency = settings?.currency ?? plan?.currency ?? campaigns[0]?.currency ?? "EUR";

  /** Sayfa verisi paralel okunur; her kaynağın hatası ayrı ele alınır. Ayarları döner (ilk yüklemede üst sınır alanı için). */
  async function load(): Promise<OrgSettings | null> {
    const [campaignsRes, connsRes, sessionRes, settingsRes, studioRes] = await Promise.allSettled([
      api<{ campaigns: CampaignData[] }>("/api/campaigns"),
      api<{ connections: { id: string; status: string }[] }>("/api/meta/connections"),
      api<{ actor: { role: string; canApproveSpend?: boolean } | null }>("/api/session"),
      api<{ settings: OrgSettings }>("/api/org/settings"),
      api<{ drafts: StudioDraftRow[] }>("/api/studio"),
    ]);
    if (campaignsRes.status === "fulfilled") {
      setCampaigns(campaignsRes.value.campaigns);
      setCampaignsError(false);
    } else {
      // Önceki liste korunur; hata ayrıca gösterilir (boş liste "kampanya yok" gibi görünmesin).
      setCampaignsError(true);
    }
    setConns(connsRes.status === "fulfilled" ? (connsRes.value.connections ?? []) : []);
    const actor = sessionRes.status === "fulfilled" ? sessionRes.value.actor : null;
    const currentRole = actor?.role ?? "";
    setRole(currentRole);
    setCanApproveSpend(Boolean(actor?.canApproveSpend));
    const orgSettings = settingsRes.status === "fulfilled" ? settingsRes.value.settings : null;
    setSettings(orgSettings);
    setApprovedDrafts(
      studioRes.status === "fulfilled" ? studioRes.value.drafts.filter((d) => d.status === "APPROVED") : [],
    );
    if (SETTINGS_ROLES.includes(currentRole)) {
      try {
        const m = await api<{ members: Member[]; canManageSpendAuthority: boolean }>("/api/org/members");
        setMembers(m.members);
        setCanManageSpend(m.canManageSpendAuthority);
      } catch {
        setMembers([]);
        setCanManageSpend(false);
      }
    } else {
      setMembers([]);
      setCanManageSpend(false);
    }
    return orgSettings;
  }
  async function reload() {
    setReloading(true);
    await load();
    setReloading(false);
  }

  useEffect(() => {
    // `?focus=<kampanyaId>`: Onaylar, Uyarılar ve lead kaynağı bu satıra bağlantı verir.
    const focus = new URLSearchParams(window.location.search).get("focus");
    if (focus) setFocusId(focus);
    void (async () => {
      const initial = await load();
      if (initial) setCapInput(initial.monthlyAdBudgetCap == null ? "" : String(initial.monthlyAdBudgetCap));
      setLoading(false);
    })();
  }, []);

  useEffect(() => {
    if (!focusId || loading) return;
    const el = document.getElementById(`campaign-${focusId}`);
    setFocusId(null);
    if (!el) {
      setFocusMissing(true);
      return;
    }
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
    el.focus({ preventScroll: true });
    setHighlightId(focusId);
  }, [focusId, loading]);

  useEffect(() => {
    if (!highlightId) return;
    const timer = window.setTimeout(() => setHighlightId(null), HIGHLIGHT_MS);
    return () => window.clearTimeout(timer);
  }, [highlightId]);

  function markBusy(id: string, action: RowAction | null) {
    setBusy((prev) => {
      const next = { ...prev };
      if (action) next[id] = action;
      else delete next[id];
      return next;
    });
  }
  function setNotes(id: string, notes: Note[]) {
    setRowNotes((prev) => ({ ...prev, [id]: notes }));
  }
  /** Diyalog kapandıktan sonra tetikleyen düğme kaybolmuş olabilir; odak kampanya satırına taşınır. */
  function focusRow(id: string) {
    window.requestAnimationFrame(() => document.getElementById(`campaign-${id}`)?.focus({ preventScroll: true }));
  }
  function toggle(list: string[], value: string, set: (v: string[]) => void) {
    set(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  }
  function autoLanguages() {
    setLanguages(marketLanguages(markets));
  }

  async function saveCap() {
    const trimmed = capInput.trim();
    const value = trimmed === "" ? null : Number(trimmed);
    if (value != null && !(Number.isFinite(value) && value > 0)) {
      setCapNote({ tone: "error", text: "Aylık üst sınır sıfırdan büyük bir tutar olmalı. Sınırı kaldırmak için alanı boş bırakıp kaydedin." });
      return;
    }
    setSavingCap(true);
    setCapNote(null);
    try {
      const o = await api<{ settings: OrgSettings }>("/api/org/settings", "PATCH", { monthlyAdBudgetCap: value });
      setSettings(o.settings);
      setCapInput(o.settings.monthlyAdBudgetCap == null ? "" : String(o.settings.monthlyAdBudgetCap));
      setCapNote({
        tone: "success",
        text:
          o.settings.monthlyAdBudgetCapCents == null
            ? "Aylık harcama üst sınırı kaldırıldı."
            : `Aylık harcama üst sınırı kaydedildi: ${money(o.settings.monthlyAdBudgetCapCents, o.settings.currency)}.`,
      });
    } catch (e) {
      setCapNote({ tone: "error", text: errorText(e, "Aylık üst sınır kaydedilemedi. Tekrar deneyin.") });
    }
    setSavingCap(false);
  }
  async function setSpendAuthority(member: Member, granted: boolean) {
    const who = member.name ?? member.email;
    setAuthorityNote(null);
    setAuthorityBusy(member.userId);
    try {
      await api(`/api/org/members/${member.userId}/spend-authority`, "PUT", { granted });
      setAuthorityNote({
        tone: "success",
        text: granted ? `${who} için harcama yetkisi verildi.` : `${who} için harcama yetkisi geri alındı.`,
      });
      await load();
    } catch (e) {
      setAuthorityNote({ tone: "error", text: errorText(e, "Harcama yetkisi güncellenemedi. Tekrar deneyin.") });
    }
    setAuthorityBusy(null);
  }
  async function buildPlan() {
    if (!budget || markets.length === 0) {
      setFormNotes([{ tone: "error", text: "Günlük bütçeyi girin ve en az bir pazar seçin." }]);
      return;
    }
    setFormNotes([]);
    setSaveError("");
    setPlanning(true);
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
    } catch (e) {
      setFormNotes([{ tone: "error", text: errorText(e, "Plan oluşturulamadı. Girdileri kontrol edip tekrar deneyin.") }]);
    }
    setPlanning(false);
  }
  async function saveDraft() {
    if (!plan) return;
    setSaving(true);
    setSaveError("");
    try {
      // Bütçe major (insan) birim gönderilir; sunucu cent'e çevirir (ADR-0011).
      const result = await api<ActionResult>("/api/campaigns", "POST", {
        name,
        objective,
        budget: parseFloat(budget) || plan.dailyBudgetCents / 100,
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
      const savedId = result.campaign?.id;
      const savedName = result.campaign?.name ?? name;
      setFormNotes([
        {
          tone: "success",
          text: `"${savedName}" taslağı kaydedildi. Sıradaki adım: reklam içeriğini ve görseli bağlayıp onaya gönderin.`,
          ...(savedId
            ? { link: { href: `#campaign-${savedId}`, label: "Kampanyaya git", onClick: () => setHighlightId(savedId) } }
            : {}),
        },
        ...warningNotes(result),
      ]);
      setPlan(null); setName(""); setBrief(""); setBudget(""); setMarkets([]); setLanguages([]); setPlanDraftIds([]); setPlanLandingUrl("");
      // Kaydet düğmesi plan kartıyla birlikte kalkar; odak sonuç mesajına taşınır.
      window.requestAnimationFrame(() => document.getElementById("planner-form-feedback")?.focus());
      await load();
    } catch (e) {
      setSaveError(errorText(e, "Taslak kaydedilemedi. Aylık üst sınırı ve içerik kontrolünü kontrol edip tekrar deneyin."));
    }
    setSaving(false);
  }

  /** Satır işlemi: sonuç (başarı, uyarı ya da hata) o kampanyanın satırında gösterilir. */
  async function runAction(c: CampaignData, action: RowAction, path: string, body: object, successText: string, fallbackError: string) {
    markBusy(c.id, action);
    setNotes(c.id, []);
    try {
      const result = await api<ActionResult>(`/api/campaigns/${c.id}/${path}`, "POST", body);
      setNotes(c.id, [{ tone: "success", text: successText }, ...warningNotes(result)]);
      await load();
    } catch (e) {
      setNotes(c.id, [{ tone: "error", text: errorText(e, fallbackError) }]);
    }
    markBusy(c.id, null);
  }
  /** Meta reklam incelemesini (effective_status + red gerekçeleri) şimdi yeniler. */
  async function refreshReview(c: CampaignData) {
    markBusy(c.id, "review");
    setNotes(c.id, []);
    try {
      const result = await api<{ campaigns: { status: string; newlyDisapproved: number; error?: string }[] }>(
        "/api/meta/review-sync",
        "POST",
        { campaignId: c.id },
      );
      const row = result.campaigns[0];
      if (row?.error) setNotes(c.id, [{ tone: "error", text: `Meta incelemesi yenilenemedi: ${row.error}` }]);
      else if (row?.status === "NO_ADS")
        setNotes(c.id, [{ tone: "warning", text: "Bu kampanyanın Meta'ya yüklenmiş reklamı yok; incelenecek reklam bulunamadı." }]);
      else if (row?.newlyDisapproved)
        setNotes(c.id, [{ tone: "warning", text: `Meta ${row.newlyDisapproved} reklamı reddetti; gerekçeler bu kampanyanın Meta incelemesi satırında.` }]);
      else setNotes(c.id, [{ tone: "success", text: "Meta inceleme durumu güncellendi." }]);
      await load();
    } catch (e) {
      setNotes(c.id, [{ tone: "error", text: errorText(e, "Meta incelemesi yenilenemedi. Birkaç dakika sonra tekrar deneyin.") }]);
    }
    markBusy(c.id, null);
  }
  /** Meta'ya kapalı yükleme: sunucu süre dolunca ilerlemeyi kaydeder; kalan adımlar için otomatik devam edilir. */
  async function publish(c: CampaignData) {
    const id = c.id;
    markBusy(id, "publish");
    setNotes(id, []);
    try {
      let last: ActionResult | undefined;
      for (let round = 0; round < MAX_PUBLISH_ROUNDS; round++) {
        last = await api<ActionResult>(`/api/campaigns/${id}/publish`, "POST", { action: "PUBLISH" });
        const progress = last.publish?.progress;
        if (progress) setLiveProgress((prev) => ({ ...prev, [id]: progress }));
        if (last.publish?.status !== "IN_PROGRESS") break;
      }
      const pending = last?.publish?.status === "IN_PROGRESS";
      setNotes(id, [
        pending
          ? { tone: "warning", text: "Meta'ya yükleme henüz bitmedi. Kaldığı yerden sürdürmek için \"Yüklemeye devam et\" düğmesine basın." }
          : { tone: "success", text: "Kampanya Meta'ya kapalı olarak yüklendi. Harcama, kampanya etkinleştirildiğinde başlar." },
        ...warningNotes(last),
      ]);
    } catch (e) {
      setNotes(id, [{ tone: "error", text: errorText(e, "Meta'ya yükleme tamamlanamadı. \"Yüklemeye devam et\" ile kaldığı yerden sürdürebilirsiniz.") }]);
    }
    await load();
    // Canlı ilerleme yalnızca yükleme sürerken gösterilir; sonrasında sunucudaki güncel durum (son hata dahil) geçerlidir.
    setLiveProgress((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    markBusy(id, null);
  }
  async function uploadImage(c: CampaignData, file: File | undefined) {
    if (!file) return;
    if (!["image/jpeg", "image/png"].includes(file.type)) {
      setNotes(c.id, [{ tone: "error", text: "Yalnızca JPEG veya PNG görsel yüklenebilir. Başka bir dosya seçin." }]);
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setNotes(c.id, [{ tone: "error", text: "Görsel en fazla 3 MB olabilir. Daha küçük bir dosya seçin." }]);
      return;
    }
    markBusy(c.id, "image");
    setNotes(c.id, []);
    try {
      const dataBase64 = await readAsDataUrl(file);
      const result = await api<ActionResult>(`/api/campaigns/${c.id}/image`, "POST", { filename: file.name, dataBase64 });
      setNotes(c.id, [{ tone: "success", text: "Görsel yüklendi." }, ...warningNotes(result)]);
      await load();
    } catch (e) {
      setNotes(c.id, [{ tone: "error", text: errorText(e, "Görsel yüklenemedi. Tekrar deneyin.") }]);
    }
    markBusy(c.id, null);
  }
  async function saveContent() {
    if (!editor) return;
    const id = editor.campaignId;
    if (editor.selected.length === 0) {
      setNotes(id, [{ tone: "error", text: "En az bir onaylı reklam içeriği seçin." }]);
      return;
    }
    markBusy(id, "content");
    setNotes(id, []);
    try {
      const result = await api<ActionResult>(`/api/campaigns/${id}/content`, "PUT", {
        draftIds: editor.selected,
        landingUrl: editor.landingUrl.trim() ? editor.landingUrl.trim() : null,
      });
      setEditor(null);
      setNotes(id, [{ tone: "success", text: "Reklam içeriği kampanyaya bağlandı." }, ...warningNotes(result)]);
      await load();
    } catch (e) {
      setNotes(id, [{ tone: "error", text: errorText(e, "İçerik bağlanamadı. Tekrar deneyin.") }]);
    }
    markBusy(id, null);
  }

  function openActivation(c: CampaignData) {
    setNotes(c.id, []);
    setActivation({ id: c.id, busy: false, error: "" });
    // Onay penceresindeki aylık toplam güncel olsun (başka sekmede değişmiş olabilir).
    api<{ settings: OrgSettings }>("/api/org/settings").then(
      (o) => setSettings(o.settings),
      () => undefined,
    );
  }
  async function confirmActivation() {
    const c = activation ? campaigns.find((x) => x.id === activation.id) : undefined;
    if (!c || !activation || activation.busy) return;
    setActivation({ ...activation, busy: true, error: "" });
    markBusy(c.id, "activate");
    try {
      const result = await api<ActionResult>(`/api/campaigns/${c.id}/publish`, "POST", { action: "ACTIVATE" });
      const daily = dailyBudgetCents(c);
      setActivation(null);
      setNotes(c.id, [
        {
          tone: "success",
          text:
            daily != null
              ? `Kampanya etkinleştirildi; günlük ${money(daily, c.currency)} harcama başladı.`
              : "Kampanya etkinleştirildi; harcama başladı.",
        },
        ...warningNotes(result),
      ]);
      await load();
      focusRow(c.id);
    } catch (e) {
      setActivation((prev) =>
        prev && prev.id === c.id
          ? { ...prev, busy: false, error: errorText(e, "Kampanya etkinleştirilemedi. Birkaç dakika sonra tekrar deneyin.") }
          : prev,
      );
    }
    markBusy(c.id, null);
  }
  function openArchive(c: CampaignData) {
    setNotes(c.id, []);
    setArchiving({ id: c.id, busy: false, error: "" });
  }
  async function confirmArchive() {
    const c = archiving ? campaigns.find((x) => x.id === archiving.id) : undefined;
    if (!c || !archiving || archiving.busy) return;
    setArchiving({ ...archiving, busy: true, error: "" });
    markBusy(c.id, "archive");
    try {
      await api<ActionResult>(`/api/campaigns/${c.id}/publish`, "POST", { action: "ARCHIVE" });
      setArchiving(null);
      setNotes(c.id, [{ tone: "success", text: "Kampanya arşivlendi; Meta'da duraklatıldı ve harcama yapmaz." }]);
      await load();
      focusRow(c.id);
    } catch (e) {
      setArchiving((prev) =>
        prev && prev.id === c.id
          ? { ...prev, busy: false, error: errorText(e, "Kampanya arşivlenemedi. Meta bağlantısını kontrol edip tekrar deneyin.") }
          : prev,
      );
    }
    markBusy(c.id, null);
  }
  function openReject(c: CampaignData) {
    setNotes(c.id, []);
    setRejecting({ id: c.id, reason: "", fieldError: "", error: "", busy: false });
  }
  async function confirmReject() {
    if (!rejecting || rejecting.busy) return;
    const reason = rejecting.reason.trim();
    if (reason.length < REJECT_REASON_MIN) {
      setRejecting({
        ...rejecting,
        fieldError: `Düzeltme gerekçesi en az ${REJECT_REASON_MIN} karakter olmalı. Neyin düzeltilmesi gerektiğini kısaca yazın.`,
      });
      window.requestAnimationFrame(() => document.getElementById(rejectFieldId)?.focus());
      return;
    }
    const id = rejecting.id;
    setRejecting({ ...rejecting, busy: true, error: "", fieldError: "" });
    markBusy(id, "reject");
    try {
      await api(`/api/campaigns/${id}/reject`, "POST", { reason });
      setRejecting(null);
      setNotes(id, [
        { tone: "success", text: "Düzeltme istendi. Gerekçe kampanya satırında görünüyor; kampanya düzeltildikten sonra yeniden onaya gönderilebilir." },
      ]);
      await load();
      focusRow(id);
    } catch (e) {
      setRejecting((prev) =>
        prev && prev.id === id
          ? { ...prev, busy: false, error: errorText(e, "Düzeltme isteği kaydedilemedi. Tekrar deneyin.") }
          : prev,
      );
    }
    markBusy(id, null);
  }

  const canEdit = EDIT_ROLES.includes(role);
  const canApprove = APPROVER_ROLES.includes(role);
  function draftLabel(d: StudioDraftRow) {
    const lang = d.content?.language;
    return `${d.name} · ${lang ? languageName(lang) : "dil belirtilmemiş"}${d.content?.service ? ` · ${d.content.service}` : ""}`;
  }
  function draftPicker(selected: string[], onToggle: (id: string) => void, neededLanguages: string[], labelId: string) {
    if (approvedDrafts.length === 0)
      return (
        <p className="text-xs text-muted">
          Onaylı reklam içeriği yok.{" "}
          <Link href="/studio" className={LINK_TEXT}>
            Reklam Oluştur
          </Link>{" "}
          sayfasında içerik üretip onaylayın.
        </p>
      );
    return (
      <div className="space-y-1.5">
        {neededLanguages.length > 0 && (
          <p className="text-xs text-muted">
            Planın dilleri: {languagesText(neededLanguages)}. Her pazar için bu dillerden en az birinde içerik gerekir.
          </p>
        )}
        <div role="group" aria-labelledby={labelId} className="flex flex-wrap gap-1.5">
          {approvedDrafts.map((d) => {
            const lang = d.content?.language ?? "";
            const relevant = neededLanguages.length === 0 || neededLanguages.includes(lang);
            return (
              <Chip
                key={d.id}
                selected={selected.includes(d.id)}
                muted={!relevant}
                onClick={() => onToggle(d.id)}
                title={d.content?.variants?.map((v) => v.headline).filter(Boolean).join(" / ")}
              >
                {draftLabel(d)}
              </Chip>
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
    const rowBusy = busy[c.id];
    if (!c.plan || !["DRAFT", "REJECTED", "IN_REVIEW", "APPROVED"].includes(c.workflowStatus)) return null;
    return (
      <div className="mt-3 space-y-2 rounded-lg bg-slate-50 p-3 text-xs text-slate-700">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-slate-800">Reklam içeriği:</span>
          {c.content ? (
            <span>
              {c.content.drafts.map((d) => `${d.name} (${languageName(d.language)})`).join(", ")}
              {c.content.landingUrl ? ` · ${c.content.landingUrl}` : ""}
            </span>
          ) : (
            <span className="text-rose-700">bağlanmadı</span>
          )}
          {editable && !editing && (
            <button
              type="button"
              disabled={Boolean(rowBusy)}
              onClick={() => setEditor({ campaignId: c.id, selected: c.content?.drafts.map((d) => d.draftId) ?? [], landingUrl: c.content?.landingUrl ?? "" })}
              className={LINK_TEXT}
            >
              {c.content ? "İçeriği değiştir" : "Onaylı içerik seç"}
            </button>
          )}
        </div>
        {editing && editor && (
          <div className="space-y-2 rounded-md border border-slate-200 bg-white p-3">
            <p id={`campaign-${c.id}-drafts`} className="font-medium text-slate-800">
              Onaylı reklam içerikleri
            </p>
            {draftPicker(
              editor.selected,
              (id) => setEditor({ ...editor, selected: editor.selected.includes(id) ? editor.selected.filter((x) => x !== id) : [...editor.selected, id] }),
              c.plan?.languages ?? [],
              `campaign-${c.id}-drafts`,
            )}
            {method === "landing_form" && (
              <label className="field">
                Açılış sayfası adresi
                <input type="url" inputMode="url" placeholder="https://…" value={editor.landingUrl} onChange={(e) => setEditor({ ...editor, landingUrl: e.target.value })} />
              </label>
            )}
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={saveContent} disabled={Boolean(rowBusy)} className={BTN_PRIMARY}>
                {rowBusy === "content" ? "Bağlanıyor…" : "İçeriği bağla"}
              </button>
              <button type="button" onClick={() => setEditor(null)} className={BTN_SECONDARY}>
                Vazgeç
              </button>
            </div>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-slate-800">Görsel:</span>
          {c.imageHash ? (
            c.imageUrl ? (
              <span>
                yüklendi ·{" "}
                <a href={c.imageUrl} target="_blank" rel="noreferrer" className={LINK_TEXT}>
                  Görseli önizle<span className="sr-only"> (yeni sekmede açılır)</span>
                </a>
              </span>
            ) : (
              <span>yüklendi</span>
            )
          ) : (
            <span className="text-rose-700">yüklenmedi</span>
          )}
          {editable && (
            <>
              {/* Dosya alanı `sr-only`: klavyeyle Tab ile ulaşılır; görünen etiket düğme gibi davranır. */}
              <label className={`${BTN_SECONDARY} relative cursor-pointer focus-within:ring-2 focus-within:ring-brand focus-within:ring-offset-2 ${rowBusy ? "pointer-events-none opacity-50" : ""}`}>
                {rowBusy === "image" ? "Görsel yükleniyor…" : c.imageHash ? "Görseli değiştir" : "Görsel yükle"}
                <input
                  type="file"
                  accept="image/jpeg,image/png"
                  className="sr-only"
                  disabled={Boolean(rowBusy)}
                  onChange={(e) => {
                    void uploadImage(c, e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
              </label>
              <span className="text-muted">JPEG veya PNG, en fazla 3 MB</span>
            </>
          )}
        </div>
        {method && <p className="text-muted">Dönüşüm yöntemi: {methodName(method)}</p>}
        {c.readiness && c.readiness.reasons.length > 0 && (
          <div>
            <p className="font-medium text-rose-800">Meta'ya yüklemeden önce tamamlanması gerekenler:</p>
            <ul className="list-inside list-disc text-rose-700">
              {c.readiness.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
        )}
        {c.readiness && c.readiness.warnings.length > 0 && (
          <ul className="list-inside list-disc text-amber-800">
            {c.readiness.warnings.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
        {c.readiness?.ready && <p className="text-emerald-800">Hazırlık tamam: kampanya Meta'ya eksiksiz yüklenebilir.</p>}
      </div>
    );
  }
  function reviewBlock(c: CampaignData) {
    const review = c.review;
    if (!review) return null;
    const style = metaReviewStyle(review.status);
    const counts = [
      review.disapproved ? `${review.disapproved} reddedildi` : "",
      review.withIssues ? `${review.withIssues} sorunlu` : "",
      review.pending ? `${review.pending} incelemede` : "",
    ].filter(Boolean);
    return (
      <div className="space-y-1 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted">Meta incelemesi:</span>
          <Badge tone={style.tone}>{style.label}</Badge>
          {counts.length > 0 && (
            <span className="text-slate-700">
              {counts.join(" · ")}
              {review.total ? ` (toplam ${review.total} reklam)` : ""}
            </span>
          )}
          {review.checkedAt && <span className="text-muted">Son kontrol: {formatDate(review.checkedAt)}</span>}
        </div>
        {review.ads.length > 0 && (
          <ul className="list-inside list-disc text-rose-700">
            {review.ads.map((ad, i) => (
              <li key={`${ad.name}-${i}`}>
                {ad.name || "Adsız reklam"}
                {ad.effectiveStatus ? ` (${adEffectiveStatusStyle(ad.effectiveStatus).label})` : ""}:{" "}
                {ad.reasons.length ? ad.reasons.join("; ") : "Meta gerekçe bildirmedi."}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  function actionsFor(c: CampaignData) {
    const w = c.workflowStatus;
    const rowBusy = busy[c.id];
    const isBusy = Boolean(rowBusy);
    const progress = liveProgress[c.id] ?? c.publish;
    const partial = w === "APPROVED" && progress.status === "IN_PROGRESS";
    const nameId = `campaign-${c.id}-name`;
    const spendReasonId = `campaign-${c.id}-spend-reason`;
    const archiveButton = (
      <button key="archive" type="button" disabled={isBusy} aria-describedby={nameId} onClick={() => openArchive(c)} className={BTN_SECONDARY}>
        {rowBusy === "archive" ? "Arşivleniyor…" : "Arşivle"}
      </button>
    );
    const buttons: ReactNode[] = [];
    if (["DRAFT", "REJECTED"].includes(w) && canEdit)
      buttons.push(
        <button
          key="submit"
          type="button"
          disabled={isBusy}
          aria-describedby={nameId}
          onClick={() =>
            runAction(c, "submit", "submit", {},
              "Kampanya onaya gönderildi. Hesap sahibi veya yönetici onayladığında Meta'ya yükleyebilirsiniz.",
              "Kampanya onaya gönderilemedi. İçeriğin ve görselin bağlı olduğunu kontrol edip tekrar deneyin.")
          }
          className={BTN_PRIMARY}
        >
          {rowBusy === "submit" ? "Gönderiliyor…" : "Onaya gönder"}
        </button>,
      );
    if (w === "IN_REVIEW" && canApprove)
      buttons.push(
        <button
          key="approve"
          type="button"
          disabled={isBusy}
          aria-describedby={nameId}
          onClick={() =>
            runAction(c, "approve", "approve", {},
              "Kampanya onaylandı. Şimdi Meta'ya kapalı olarak yükleyebilirsiniz.",
              "Kampanya onaylanamadı. Birkaç dakika sonra tekrar deneyin.")
          }
          className={BTN_PRIMARY}
        >
          {rowBusy === "approve" ? "Onaylanıyor…" : "Onayla"}
        </button>,
        <button key="reject" type="button" disabled={isBusy} aria-describedby={nameId} onClick={() => openReject(c)} className={BTN_SECONDARY}>
          Düzeltme iste
        </button>,
      );
    if (w === "APPROVED" && canEdit) {
      buttons.push(
        <button key="publish" type="button" disabled={isBusy} aria-describedby={nameId} onClick={() => publish(c)} className={BTN_PRIMARY}>
          {rowBusy === "publish" ? "Meta'ya yükleniyor…" : partial ? "Yüklemeye devam et" : "Meta'ya yükle (kapalı)"}
        </button>,
      );
      if (partial && !isBusy) buttons.push(archiveButton);
    }
    if (w === "PUBLISHED_PAUSED") {
      buttons.push(
        <button
          key="activate"
          type="button"
          disabled={isBusy || !canApproveSpend}
          aria-describedby={canApproveSpend ? nameId : `${nameId} ${spendReasonId}`}
          onClick={() => openActivation(c)}
          className={BTN_PRIMARY}
        >
          {rowBusy === "activate" ? "Etkinleştiriliyor…" : "Etkinleştir"}
        </button>,
      );
      if (canEdit) buttons.push(archiveButton);
    }
    if (w === "ACTIVE" && canEdit)
      buttons.push(
        <button
          key="pause"
          type="button"
          disabled={isBusy}
          aria-describedby={nameId}
          onClick={() =>
            runAction(c, "pause", "publish", { action: "PAUSE" },
              "Kampanya duraklatıldı; harcama durdu. Harcama yetkisi olan kişi yeniden etkinleştirebilir.",
              "Kampanya duraklatılamadı. Meta bağlantısını kontrol edip tekrar deneyin.")
          }
          className={BTN_SECONDARY}
        >
          {rowBusy === "pause" ? "Duraklatılıyor…" : "Duraklat"}
        </button>,
        archiveButton,
      );
    if (["PUBLISHED_PAUSED", "ACTIVE"].includes(w) && c.ads > 0 && canEdit)
      buttons.push(
        <button
          key="review"
          type="button"
          disabled={isBusy}
          aria-describedby={nameId}
          onClick={() => refreshReview(c)}
          title="Reklamların Meta inceleme durumunu ve red gerekçelerini şimdi okur"
          className={BTN_SECONDARY}
        >
          {rowBusy === "review" ? "Yenileniyor…" : "İncelemeyi yenile"}
        </button>,
      );
    const hint =
      w === "PUBLISHED_PAUSED" && !canApproveSpend ? (
        <p id={spendReasonId} className="text-xs text-muted sm:text-right">
          Harcama yetkisi gerekli: yalnızca hesap sahibi veya yetki verdiği üye etkinleştirebilir.
        </p>
      ) : w === "IN_REVIEW" && !canApprove ? (
        <p className="text-xs text-muted sm:text-right">Onayı hesap sahibi veya yönetici verir.</p>
      ) : null;
    if (buttons.length === 0 && !hint) return null;
    return (
      <div className="flex max-w-full flex-col gap-1.5 sm:max-w-sm sm:items-end">
        {buttons.length > 0 && <div className="flex flex-wrap items-center gap-2 sm:justify-end">{buttons}</div>}
        {hint}
      </div>
    );
  }
  function campaignRow(c: CampaignData) {
    const progress = liveProgress[c.id] ?? c.publish;
    const stage = campaignStage(c.workflowStatus, {
      publishIncomplete: c.workflowStatus === "APPROVED" && progress.status === "IN_PROGRESS",
      metaPaused: c.workflowStatus === "ACTIVE" && c.status === "PAUSED",
    });
    const daily = dailyBudgetCents(c);
    const summary = [
      campaignObjectiveName(c.objective),
      daily != null ? `${money(daily, c.currency)}/gün` : null,
      `${c.adSets} reklam seti`,
      c.ads ? `${c.ads} reklam` : null,
      c.policyRisk ? `İçerik kontrolü: ${policyRiskStyle(c.policyRisk).label.toLocaleLowerCase("tr-TR")}` : null,
      `Oluşturma: ${formatDay(c.createdAt)}`,
    ].filter(Boolean);
    const lastError = c.workflowStatus === "APPROVED" ? progress.lastError : null;
    const highlighted = highlightId === c.id;
    return (
      <li
        key={c.id}
        id={`campaign-${c.id}`}
        tabIndex={-1}
        className={`scroll-mt-24 rounded-lg border p-3 transition-colors duration-700 ${highlighted ? "border-brand bg-violet-50 ring-2 ring-brand" : "border-slate-200 bg-white"}`}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3
                id={`campaign-${c.id}-name`}
                className="text-sm font-semibold text-slate-900"
                title={c.metaCampaignId ? `Meta kampanya kimliği: ${c.metaCampaignId}` : undefined}
              >
                {c.name}
              </h3>
              <StageBar stage={stage} />
            </div>
            <p className="text-xs text-muted">{summary.join(" · ")}</p>
            {c.rejectionReason && <p className="text-xs text-rose-700">Düzeltme gerekçesi: {c.rejectionReason}</p>}
            {(progress.status === "IN_PROGRESS" || busy[c.id] === "publish") && c.workflowStatus === "APPROVED" && (
              <p className="text-xs text-sky-800">Meta'ya yükleme: {progressText(progress)}</p>
            )}
            {lastError && (
              <p className="text-xs text-rose-700">
                Son hata ({publishStepLabel(lastError.step)} adımında{lastError.at ? `, ${formatDate(lastError.at)}` : ""}): {lastError.message}
              </p>
            )}
            {reviewBlock(c)}
          </div>
          {actionsFor(c)}
        </div>
        <Feedback notes={rowNotes[c.id] ?? []} />
        {preparation(c)}
      </li>
    );
  }
  /** Etkinleştirme onayının gövdesi: harcanacak para, aylık etki ve Meta reddi uyarısı (hepsi `aria-describedby`). */
  function activationSummary(c: CampaignData) {
    const daily = dailyBudgetCents(c);
    const monthly = daily != null ? daily * MONTH_DAYS : null;
    const sameCurrency = settings != null && settings.currency === (c.currency ?? "EUR");
    // Kampanya Meta'da zaten etkin sayılıyorsa (rezervasyon) toplamda iki kez sayılmasın (sunucu da hariç tutar).
    const others =
      settings && sameCurrency
        ? Math.max(0, settings.monthlyCommittedCents - (c.status === "ACTIVE" && monthly != null ? monthly : 0))
        : null;
    const total = others != null && monthly != null ? others + monthly : null;
    const cap = settings && sameCurrency ? settings.monthlyAdBudgetCapCents : null;
    const exceeds = total != null && cap != null && total > cap;
    const disapproved = c.review?.disapproved ?? 0;
    return (
      <div className="space-y-3">
        <p>
          {daily != null ? (
            <>
              <span className="font-semibold text-slate-900">{c.name}</span> için günlük{" "}
              <span className="font-semibold text-slate-900">{money(daily, c.currency)}</span> harcama başlayacak.
            </>
          ) : (
            <>
              <span className="font-semibold text-slate-900">{c.name}</span> etkinleştirilince harcama, Meta'daki bütçe ayarına göre başlayacak.
            </>
          )}
        </p>
        {monthly != null && (
          <ul className="list-inside list-disc space-y-1">
            <li>Bu kampanyanın aylık tahmini {money(monthly, c.currency)} (günlük bütçe × {MONTH_DAYS}).</li>
            {total != null &&
              (cap != null ? (
                <li>
                  Etkin kampanyalarla birlikte aylık tahmini {money(total, c.currency)} / üst sınır {money(cap, c.currency)}.
                </li>
              ) : (
                <li>Etkin kampanyalarla birlikte aylık tahmini {money(total, c.currency)}; aylık üst sınır tanımlı değil.</li>
              ))}
          </ul>
        )}
        {exceeds && (
          <p className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-rose-800">
            Bu toplam aylık üst sınırı aşıyor; etkinleştirme engellenecek. Önce üst sınırı yükseltin ya da etkin bir kampanyayı duraklatın.
          </p>
        )}
        {disapproved > 0 && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-900">
            Meta {disapproved} reklamı reddetti; reddedilen reklamlar yayınlanmaz. Önce düzeltmeniz önerilir.
          </p>
        )}
      </div>
    );
  }

  const canEditCap = SETTINGS_ROLES.includes(role);
  const capCents = settings?.monthlyAdBudgetCapCents ?? null;
  const committedCents = settings?.monthlyCommittedCents ?? 0;
  const delegableMembers = members.filter((m) => m.role !== "OWNER");
  const activationCampaign = activation ? (campaigns.find((c) => c.id === activation.id) ?? null) : null;
  const archiveCampaign = archiving ? (campaigns.find((c) => c.id === archiving.id) ?? null) : null;
  const rejectCampaign = rejecting ? (campaigns.find((c) => c.id === rejecting.id) ?? null) : null;
  const metaDisconnected = conns.some((c) => c.status === "EXPIRED" || c.status === "REVOKED");
  const rejectLength = rejecting?.reason.length ?? 0;
  return (
    <div className="space-y-8">
      <PageHeader
        title="Kampanya planlayıcı"
        description="AI ajan pazarları, dilleri ve bütçe türünü planlar; kampanya onaylanmadan yayınlanmaz."
        crumbs={[{ label: "Kampanyalar" }]}
      />
      {metaDisconnected && (
        <Link href="/meta-connections" className="block rounded-xl border border-rose-300 bg-rose-50 p-3 text-sm text-rose-800 hover:bg-rose-100">
          Meta bağlantısı kesildi. Kampanya işlemlerini sürdürmek için Meta bağlantıları sayfasından bağlantıyı yenileyin.
        </Link>
      )}
      <Card>
        <SectionHeading
          title="Aylık harcama üst sınırı"
          description="Etkin kampanyaların aylık toplamı ile yeni ya da artırılan günlük bütçenin 30 katı bu sınırı aşarsa işlem engellenir."
        />
        <div className="space-y-3">
          <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-700">
            <span>
              Geçerli sınır: <span className="font-semibold">{capCents == null ? "tanımlı değil" : money(capCents, currency)}</span>
            </span>
            <span className="text-muted">Etkin kampanyalar: {money(committedCents, currency)}/ay</span>
            {capCents != null && <span className="text-muted">Kalan: {money(Math.max(0, capCents - committedCents), currency)}/ay</span>}
          </p>
          {canEditCap ? (
            <div className="flex flex-wrap items-end gap-3">
              <label className="field w-64 max-w-full">
                Yeni aylık üst sınır ({currency})
                <input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="0.01"
                  value={capInput}
                  onChange={(e) => setCapInput(e.target.value)}
                  aria-describedby={capHintId}
                />
              </label>
              <button type="button" onClick={saveCap} disabled={savingCap} className="secondary-button">
                {savingCap ? "Kaydediliyor…" : "Üst sınırı kaydet"}
              </button>
              <p id={capHintId} className="basis-full text-xs text-muted">
                Sınırı hesap sahibi ve yöneticiler düşürebilir; yükseltmek ya da kaldırmak (alanı boş bırakıp kaydetmek) yalnızca hesap
                sahibine açıktır.
              </p>
            </div>
          ) : (
            <p className="text-xs text-muted">Üst sınırı yalnızca hesap sahibi veya yönetici değiştirebilir.</p>
          )}
          <Feedback notes={capNote ? [capNote] : []} className="" />
        </div>
      </Card>
      {SETTINGS_ROLES.includes(role) && (
        <Card>
          <SectionHeading
            title="Harcama yetkisi"
            description="Kampanyayı etkinleştirmek ve bütçeyi artırmak yalnızca hesap sahibine ya da hesap sahibinin yetki verdiği yönetici veya reklam uzmanına açıktır. Her değişiklik denetim kaydına yazılır."
          />
          {delegableMembers.length === 0 ? (
            <EmptyState message="Yetki verilebilecek başka üye yok." />
          ) : (
            <ul className="space-y-2">
              {delegableMembers.map((m) => {
                const who = m.name ?? m.email;
                return (
                  <li key={m.userId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 p-2.5 text-sm">
                    <div className="min-w-0">
                      <span className="font-medium text-slate-800">{who}</span>
                      <span className="ml-2 text-xs text-muted">
                        {m.email} · {roleLabel(m.role)}
                        {m.status !== "ACTIVE" ? ` · ${membershipStatusLabel(m.status)}` : ""}
                      </span>
                      {m.canApproveSpend && m.spendGrantedAt && (
                        <span className="ml-2 text-xs text-muted">
                          Yetki: {formatDay(m.spendGrantedAt)}
                          {m.spendGrantedBy ? `, veren ${m.spendGrantedBy}` : ""}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge tone={m.canApproveSpend ? "green" : "gray"}>{m.canApproveSpend ? "Harcama yetkisi var" : "Harcama yetkisi yok"}</Badge>
                      {canManageSpend && m.delegable && (
                        <button
                          type="button"
                          disabled={authorityBusy === m.userId}
                          aria-label={`${m.canApproveSpend ? "Yetkiyi geri al" : "Yetki ver"}: ${who}`}
                          onClick={() => setSpendAuthority(m, !m.canApproveSpend)}
                          className={BTN_SECONDARY}
                        >
                          {m.canApproveSpend ? "Yetkiyi geri al" : "Yetki ver"}
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {!canManageSpend && <p className="mt-2 text-xs text-muted">Harcama yetkisini yalnızca hesap sahibi verebilir veya geri alabilir.</p>}
          <Feedback notes={authorityNote ? [authorityNote] : []} />
        </Card>
      )}
      <Card>
        <SectionHeading title="Hedef ve kısıtlar" description="Hedefi doğal dille yazın; pazar, dil ve bütçeyi seçin. AI ajan planı gerekçeleriyle birlikte önerir." />
        <div className="mt-6 space-y-5">
          <label className="field">
            Reklam hedefi
            <textarea
              rows={3}
              placeholder="Ör. Almanya'dan saç ekimi hedefleyen 30-50 yaş arası, uygun fiyat vurgusu"
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
            />
          </label>
          <div className="grid gap-4 sm:grid-cols-3">
            <label className="field">
              Kampanya hedefi
              <select value={objective} onChange={(e) => setObjective(e.target.value)}>
                {Object.entries(OBJECTIVE_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Günlük bütçe ({currency})
              <input type="number" inputMode="decimal" min={0} step="0.01" value={budget} onChange={(e) => setBudget(e.target.value)} />
            </label>
            <label className="field">
              Dönüşüm yöntemi
              <select value={conversionMethod} onChange={(e) => setConversionMethod(e.target.value)}>
                {Object.entries(METHOD_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <p id={marketsLabelId} className="mb-1.5 text-xs font-medium text-muted">
                Pazar (ülke)
              </p>
              <div role="group" aria-labelledby={marketsLabelId} className="flex flex-wrap gap-1.5">
                {MARKET_CODES.map((m) => (
                  <Chip key={m} selected={markets.includes(m)} onClick={() => toggle(markets, m, setMarkets)}>
                    {PLANNER_MARKETS[m]}
                  </Chip>
                ))}
              </div>
            </div>
            <div>
              <div className="mb-1.5 flex flex-wrap items-center gap-2">
                <p id={languagesLabelId} className="text-xs font-medium text-muted">
                  Reklam dili
                </p>
                <button type="button" onClick={autoLanguages} disabled={markets.length === 0} className={`text-xs ${LINK_TEXT}`}>
                  Pazardan otomatik seç
                </button>
              </div>
              <div role="group" aria-labelledby={languagesLabelId} className="flex flex-wrap gap-1.5">
                {BRIEF_LANGUAGES.map((l) => (
                  <Chip key={l} selected={languages.includes(l)} onClick={() => toggle(languages, l, setLanguages)}>
                    {languageName(l)}
                  </Chip>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <label className="field w-28">
                En düşük yaş
                <input type="number" min={18} max={64} value={ageMin} onChange={(e) => setAgeMin(e.target.value)} />
              </label>
              <label className="field w-28">
                En yüksek yaş
                <input type="number" min={18} max={64} value={ageMax} onChange={(e) => setAgeMax(e.target.value)} />
              </label>
              <label className="field">
                Bütçe türü
                <select value={strategy} onChange={(e) => setStrategy(e.target.value)}>
                  <option value="">Otomatik</option>
                  <option value="CBO">{budgetModeLabel("CBO")}</option>
                  <option value="ABO">{budgetModeLabel("ABO")}</option>
                </select>
              </label>
            </div>
          </div>
          <button type="button" onClick={buildPlan} disabled={planning} className="primary-button">
            {planning ? "Planlanıyor…" : "AI ile taslak oluştur"}
          </button>
          <Feedback id="planner-form-feedback" notes={formNotes} className="" />
        </div>
      </Card>
      {plan && (
        <Card>
          <SectionHeading
            title={`Plan: ${plan.name}`}
            description={[
              campaignObjectiveName(objective),
              `${money(plan.dailyBudgetCents, plan.currency)}/gün`,
              budgetModeLabel(plan.strategy),
            ]
              .filter(Boolean)
              .join(" · ")}
          />
          <div className="mt-4 space-y-4">
            {plan.blocked && (
              <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
                <p className="font-medium">Plan engellendi</p>
                <ul className="mt-1 list-inside list-disc text-xs">
                  {plan.blockingReasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
                <p className="mt-2 text-xs">Nedenleri giderip planı yeniden oluşturun; engellenen plan taslak olarak kaydedilemez.</p>
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <PlanBox title="Yapı" reason={plan.reasons.strategy}>
                {plan.structure}
              </PlanBox>
              <PlanBox title="Hedefleme">{plan.targetingRationale}</PlanBox>
              <PlanBox title="Kampanya hedefi" reason={plan.reasons.objective}>
                {campaignObjectiveName(objective) ?? "—"}
              </PlanBox>
              <PlanBox title="Dönüşüm yöntemi" reason={plan.reasons.conversionMethod}>
                {methodName(conversionMethod)}
              </PlanBox>
              <PlanBox title="Test planı" reason={plan.reasons.testPlan}>
                {plan.testPlan.creativeVariations} varyasyon (1 kontrol + {plan.testPlan.creativeVariations - 1} varyant) ·{" "}
                {plan.testPlan.testDurationDays} gün · karar ölçütü: {plan.testPlan.decisionMetric}
              </PlanBox>
              <PlanBox title="Öngörülen aylık harcama">
                <p className="font-semibold">{money(plan.monthlyProjectedCents, plan.currency)}</p>
                {plan.monthlyCommittedCents > 0 && (
                  <p className="mt-1 text-xs text-muted">Etkin kampanyalar: {money(plan.monthlyCommittedCents, plan.currency)}/ay</p>
                )}
                {settings?.monthlyAdBudgetCapCents != null && (
                  <p className="mt-1 text-xs text-muted">Aylık harcama üst sınırı: {money(settings.monthlyAdBudgetCapCents, plan.currency)}</p>
                )}
              </PlanBox>
              <PlanBox title="Reklam setleri (pazar ve dil başına)" className="sm:col-span-2">
                <ul className="space-y-1">
                  {plan.adSets.map((a) => (
                    <li key={a.market}>
                      <span className="font-medium">{PLANNER_MARKETS[a.market] ?? countryName(a.market)}</span>
                      <span className="ml-2 text-xs text-muted">
                        ülkeler: {countriesText(a.targeting.geo_locations.countries)} · diller: {languagesText(a.targeting.locales)} ·{" "}
                        {a.targeting.age_min}–{a.targeting.age_max} yaş · bütçe:{" "}
                        {a.dailyBudgetCents == null ? "kampanya düzeyinde (CBO)" : `${money(a.dailyBudgetCents, plan.currency)}/gün`}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-muted">
                  Meta'ya yüklenirken her reklam seti, içeriği olan her dil için ayrı bir reklam seti olarak kurulur (reklam dili = hedeflenen
                  dil).
                </p>
              </PlanBox>
              <PlanBox title="Reklam içeriği (isteğe bağlı; sonra da seçebilirsiniz)" titleId={planDraftsLabelId} className="sm:col-span-2">
                {draftPicker(
                  planDraftIds,
                  (id) => setPlanDraftIds(planDraftIds.includes(id) ? planDraftIds.filter((x) => x !== id) : [...planDraftIds, id]),
                  plan.languages,
                  planDraftsLabelId,
                )}
                {conversionMethod === "landing_form" && planDraftIds.length > 0 && (
                  <label className="field mt-2">
                    Açılış sayfası adresi
                    <input type="url" inputMode="url" placeholder="https://…" value={planLandingUrl} onChange={(e) => setPlanLandingUrl(e.target.value)} />
                  </label>
                )}
              </PlanBox>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <label className="field min-w-0 flex-1">
                Kampanya adı
                <input required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
              </label>
              <button type="button" onClick={saveDraft} disabled={saving || plan.blocked} className="primary-button">
                {saving ? "Kaydediliyor…" : "Taslağı kaydet"}
              </button>
            </div>
            <Feedback notes={saveError ? [{ tone: "error", text: saveError }] : []} className="" />
          </div>
        </Card>
      )}
      <Card>
        <SectionHeading
          title="Kampanyalar"
          description="Her kampanya onaydan geçer, Meta'ya kapalı yüklenir ve harcamayı yalnızca harcama yetkisi olan kişi başlatır."
        />
        {focusMissing && !campaignsError && (
          <p className="mb-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-muted">
            Bağlantıdaki kampanya bu listede bulunamadı; silinmiş ya da başka bir çalışma alanına ait olabilir.
          </p>
        )}
        {loading ? (
          <div role="status" aria-label="Kampanyalar yükleniyor" className="h-16 animate-pulse rounded-xl bg-slate-200/60" />
        ) : campaignsError && campaigns.length === 0 ? (
          <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
            Kampanyalar yüklenemedi. Bağlantınızı kontrol edip tekrar deneyin.
            <button type="button" onClick={reload} disabled={reloading} className="secondary-button">
              {reloading ? "Yükleniyor…" : "Tekrar dene"}
            </button>
          </div>
        ) : campaigns.length === 0 ? (
          <EmptyState message="Henüz kampanya yok. Yukarıdaki formla ilk kampanya taslağınızı oluşturun." />
        ) : (
          <>
            {campaignsError && (
              <div role="alert" className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                Kampanya listesi yenilenemedi; gösterilen bilgiler güncel olmayabilir.
                <button type="button" onClick={reload} disabled={reloading} className={BTN_SECONDARY}>
                  {reloading ? "Yükleniyor…" : "Tekrar dene"}
                </button>
              </div>
            )}
            <ul className="space-y-3">{campaigns.map((c) => campaignRow(c))}</ul>
          </>
        )}
      </Card>
      <ConfirmDialog
        open={activationCampaign != null}
        title="Kampanya etkinleştirilsin mi?"
        description={activationCampaign ? activationSummary(activationCampaign) : undefined}
        confirmLabel="Kampanyayı etkinleştir"
        cancelLabel="Vazgeç"
        busy={activation?.busy}
        busyLabel="Etkinleştiriliyor…"
        error={activation?.error}
        onConfirm={confirmActivation}
        onCancel={() => setActivation(null)}
      />
      <ConfirmDialog
        open={archiveCampaign != null}
        title="Kampanya arşivlensin mi?"
        description={
          archiveCampaign ? (
            <p>
              <span className="font-semibold text-slate-900">{archiveCampaign.name}</span> Meta'da duraklatılır ve arşive taşınır
              {archiveCampaign.workflowStatus === "ACTIVE" ? "; harcama hemen durur" : ""}. Arşivdeki kampanya bu ekrandan yeniden
              etkinleştirilemez.
            </p>
          ) : undefined
        }
        confirmLabel="Kampanyayı arşivle"
        cancelLabel="Vazgeç"
        tone="danger"
        busy={archiving?.busy}
        busyLabel="Arşivleniyor…"
        error={archiving?.error}
        onConfirm={confirmArchive}
        onCancel={() => setArchiving(null)}
      />
      <Dialog
        open={rejectCampaign != null}
        title="Kampanyada düzeltme iste"
        description={
          rejectCampaign ? (
            <p>
              <span className="font-semibold text-slate-900">{rejectCampaign.name}</span> onaydan geri çevrilir. Gerekçeniz kampanya
              satırında gösterilir; kampanya düzeltildikten sonra yeniden onaya gönderilebilir.
            </p>
          ) : undefined
        }
        onClose={() => {
          if (!rejecting?.busy) setRejecting(null);
        }}
        footer={
          <>
            <button type="button" className="secondary-button" disabled={rejecting?.busy} onClick={() => setRejecting(null)}>
              Vazgeç
            </button>
            <button type="button" className="primary-button" disabled={rejecting?.busy} onClick={confirmReject}>
              {rejecting?.busy ? "Kaydediliyor…" : "Düzeltme iste"}
            </button>
          </>
        }
      >
        <div className="space-y-1.5">
          <label className="field" htmlFor={rejectFieldId}>
            Düzeltme gerekçesi
            <textarea
              id={rejectFieldId}
              rows={4}
              required
              minLength={REJECT_REASON_MIN}
              maxLength={REJECT_REASON_MAX}
              value={rejecting?.reason ?? ""}
              aria-invalid={rejecting?.fieldError ? true : undefined}
              aria-describedby={rejecting?.fieldError ? `${rejectErrorId} ${rejectHintId}` : rejectHintId}
              onChange={(e) => {
                const reason = e.target.value;
                setRejecting((prev) =>
                  prev
                    ? { ...prev, reason, fieldError: prev.fieldError && reason.trim().length >= REJECT_REASON_MIN ? "" : prev.fieldError }
                    : prev,
                );
              }}
            />
          </label>
          {rejecting?.fieldError ? (
            <p id={rejectErrorId} role="alert" className="text-xs font-medium text-rose-700">
              {rejecting.fieldError}
            </p>
          ) : null}
          <p id={rejectHintId} className="text-xs text-muted">
            En az {REJECT_REASON_MIN}, en fazla {REJECT_REASON_MAX} karakter ({rejectLength}/{REJECT_REASON_MAX}).
          </p>
          {rejecting?.error ? (
            <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
              {rejecting.error}
            </p>
          ) : null}
        </div>
      </Dialog>
    </div>
  );
}

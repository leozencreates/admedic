"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState, type ReactNode } from "react";
import { api } from "../_lib/client-api";
import { Badge, Card, EmptyState, PageHeader, SectionHeading } from "../_components/ui";
import { METHOD_LABEL, OBJECTIVE_LABEL, PLANNER_MARKETS, marketLanguages } from "../_lib/campaign-plan";
import type { PlanAdSet, PlanReasons } from "../_lib/campaign-plan";
import { BRIEF_LANGUAGES } from "../_lib/creative-lang";
import { formatDay } from "../_lib/format";
import { budgetModeLabel, countryName, languageName, membershipStatusLabel, roleLabel } from "../_lib/labels";
import {
  BTN_SECONDARY,
  Chip,
  DraftPicker,
  Feedback,
  LINK_TEXT,
  SETTINGS_ROLES,
  campaignObjectiveName,
  countriesText,
  errorText,
  languagesText,
  methodName,
  money,
  warningNotes,
  type ActionResult,
  type Note,
  type OrgSettings,
  type StudioDraftRow,
} from "../_lib/campaign-ui";

const MARKET_CODES = Object.keys(PLANNER_MARKETS);

interface Plan { name: string; dailyBudgetCents: number; monthlyProjectedCents: number; monthlyCommittedCents: number; currency: string; structure: string; strategy: string; rationale: string; targetingRationale: string; blocked: boolean; blockingReasons: string[]; testPlan: { creativeVariations: number; testDurationDays: number; decisionMetric: string }; adSets: PlanAdSet[]; reasons: PlanReasons; languages: string[]; }
interface Member { userId: string; email: string; name: string | null; role: string; status: string; isSelf: boolean; canApproveSpend: boolean; delegable: boolean; spendGrantedAt: string | null; spendGrantedBy: string | null; }

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

/**
 * "Yeni kampanya" (K5-C): aylık harcama üst sınırı, harcama yetkisi ve AI planlı kampanya taslağı.
 * Kaydedilen taslak kendi kampanya sayfasında (`/campaigns/<id>`) hazırlanır, onaya gönderilir ve yayınlanır.
 */
export default function CampaignPlannerPage() {
  const router = useRouter();
  const [role, setRole] = useState<string>("");
  const [settings, setSettings] = useState<OrgSettings | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [canManageSpend, setCanManageSpend] = useState(false);
  const [approvedDrafts, setApprovedDrafts] = useState<StudioDraftRow[]>([]);
  const [capInput, setCapInput] = useState("");
  const [savingCap, setSavingCap] = useState(false);
  const [capNote, setCapNote] = useState<Note | null>(null);
  const [authorityBusy, setAuthorityBusy] = useState<string | null>(null);
  const [authorityNote, setAuthorityNote] = useState<Note | null>(null);
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
  const marketsLabelId = useId();
  const languagesLabelId = useId();
  const planDraftsLabelId = useId();
  const capHintId = useId();
  const currency = settings?.currency ?? plan?.currency ?? "EUR";

  /** Sayfa verisi paralel okunur; her kaynağın hatası ayrı ele alınır. Ayarları döner (ilk yüklemede üst sınır alanı için). */
  async function load(): Promise<OrgSettings | null> {
    const [sessionRes, settingsRes, studioRes] = await Promise.allSettled([
      api<{ actor: { role: string } | null }>("/api/session"),
      api<{ settings: OrgSettings }>("/api/org/settings"),
      api<{ drafts: StudioDraftRow[] }>("/api/studio"),
    ]);
    const actor = sessionRes.status === "fulfilled" ? sessionRes.value.actor : null;
    const currentRole = actor?.role ?? "";
    setRole(currentRole);
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

  useEffect(() => {
    // Eski bağlantılar (`?focus=<kampanyaId>`) kampanyanın kendi sayfasına yönlenir.
    const focus = new URLSearchParams(window.location.search).get("focus");
    if (focus) {
      router.replace(`/campaigns/${encodeURIComponent(focus)}`);
      return;
    }
    void (async () => {
      const initial = await load();
      if (initial) setCapInput(initial.monthlyAdBudgetCap == null ? "" : String(initial.monthlyAdBudgetCap));
    })();
  }, []);

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
      if (savedId) {
        // Sıradaki adımlar (içerik, görsel, onay, yükleme) kampanyanın kendi sayfasında.
        router.push(`/campaigns/${encodeURIComponent(savedId)}`);
        return;
      }
      const savedName = result.campaign?.name ?? name;
      setFormNotes([
        {
          tone: "success",
          text: `"${savedName}" taslağı kaydedildi. Sıradaki adım: reklam içeriğini ve görseli bağlayıp onaya gönderin.`,
          link: { href: "/campaigns", label: "Kampanyalara git" },
        },
        ...warningNotes(result),
      ]);
      setPlan(null); setName(""); setBrief(""); setBudget(""); setMarkets([]); setLanguages([]); setPlanDraftIds([]); setPlanLandingUrl("");
      // Kaydet düğmesi plan kartıyla birlikte kalkar; odak sonuç mesajına taşınır.
      window.requestAnimationFrame(() => document.getElementById("planner-form-feedback")?.focus());
    } catch (e) {
      setSaveError(errorText(e, "Taslak kaydedilemedi. Aylık üst sınırı ve içerik kontrolünü kontrol edip tekrar deneyin."));
    }
    setSaving(false);
  }

  const canEditCap = SETTINGS_ROLES.includes(role);
  const capCents = settings?.monthlyAdBudgetCapCents ?? null;
  const committedCents = settings?.monthlyCommittedCents ?? 0;
  const delegableMembers = members.filter((m) => m.role !== "OWNER");
  return (
    <div className="space-y-8">
      <PageHeader
        title="Yeni kampanya"
        description="AI ajan pazarları, dilleri ve bütçe türünü planlar; kampanya onaylanmadan yayınlanmaz."
        crumbs={[{ label: "Kampanyalar", href: "/campaigns" }]}
      />
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
                <DraftPicker
                  drafts={approvedDrafts}
                  selected={planDraftIds}
                  onToggle={(id) => setPlanDraftIds(planDraftIds.includes(id) ? planDraftIds.filter((x) => x !== id) : [...planDraftIds, id])}
                  neededLanguages={plan.languages}
                  labelId={planDraftsLabelId}
                />
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
      <p className="text-sm text-ink-2">
        Mevcut kampanyalarınız{" "}
        <Link href="/campaigns" className={LINK_TEXT}>
          Kampanyalar
        </Link>{" "}
        sayfasında.
      </p>
    </div>
  );
}

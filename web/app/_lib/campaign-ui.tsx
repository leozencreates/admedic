/**
 * Kampanya arayüzü ortak parçaları (istemci): "Yeni kampanya" (planlayıcı) ve kampanya sayfası
 * (`/campaigns/[id]`) aynı türleri, biçim yardımcılarını, sonuç mesajlarını ve içerik seçiciyi kullanır.
 * Sunucu mantığı yoktur; tüm işlemler mevcut API uçlarını çağırır.
 */
import Link from "next/link";
import type { ReactNode } from "react";
import { METHOD_LABEL, OBJECTIVE_LABEL } from "./campaign-plan";
import type { PlanReasons } from "./campaign-plan";
import { formatMoney } from "./format";
import { countryName, languageName, objectiveLabel } from "./labels";

export const SETTINGS_ROLES = ["OWNER", "ADMIN"];
/** İçerik, yükleme, duraklatma ve arşivleme (sunucudaki `EDIT_ROLES`). */
export const EDIT_ROLES = ["OWNER", "ADMIN", "MEDIA_BUYER"];
/** Onaylama ve düzeltme isteme (sunucudaki `approve` / `reject` uçlarıyla aynı roller). */
export const APPROVER_ROLES = ["OWNER", "ADMIN"];
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
/** Tam yükleme uzun sürerse sunucu ilerlemeyi kaydedip IN_PROGRESS döner; istemci bu kadar tur devam ettirir. */
export const MAX_PUBLISH_ROUNDS = 20;
/** Aylık tahmin: günlük bütçe × 30 (sunucudaki `MONTH_DAYS`). */
export const MONTH_DAYS = 30;
export const REJECT_REASON_MIN = 3;
export const REJECT_REASON_MAX = 500;

export const BTN_PRIMARY = "primary-button min-h-9 px-3 py-1.5 text-xs";
export const BTN_SECONDARY = "secondary-button min-h-9 px-3 py-1.5 text-xs";
export const LINK_TEXT = "font-medium text-violet-700 underline-offset-2 hover:underline";

export interface ContentSummary { attachedAt: string; landingUrl: string | null; languages: string[]; drafts: { draftId: string; name: string; language: string; headlines: string[]; formQuestions: number }[]; }
export interface Readiness { ready: boolean; reasons: string[]; warnings: string[]; }
export interface ReviewSummary { status: string; checkedAt: string | null; disapproved: number; withIssues: number; pending: number; total: number | null; ads: { name: string; effectiveStatus: string | null; reasons: string[] }[]; }
export interface PublishProgress { status: "NOT_STARTED" | "IN_PROGRESS" | "COMPLETE" | "EXTERNAL"; campaignCreated: boolean; adSets: { total: number; published: number }; ads: { expected: number; published: number }; leadForms: number; creatives: number; lastError: { step: string; message: string; at: string } | null; }
/** Kampanyada saklanan plan (planlayıcı çıktısı); eski kayıtlarda alanlar eksik olabilir. */
export interface StoredPlan {
  conversionMethod?: string; strategy?: string; languages?: string[]; markets?: string[]; ageMin?: number; ageMax?: number;
  rationale?: string; targetingRationale?: string; structure?: string; reasons?: Partial<PlanReasons>; monthlyProjectedCents?: number;
  testPlan?: { creativeVariations: number; testDurationDays: number; decisionMetric: string };
}
/** Bütçeler minor unit (cent) gelir; `status` Meta'daki durum, `workflowStatus` onay/yayın akışıdır. */
export interface CampaignData {
  id: string; name: string; status: string; workflowStatus: string; policyRisk: string | null; objective: string | null;
  dailyBudget: number | null; budgetCents: number | null; currency: string | null; adSets: number; ads: number; createdAt: string;
  metaCampaignId: string | null; rejectionReason: string | null; imageHash: string | null; imageUrl: string | null;
  plan: StoredPlan | null;
  content: ContentSummary | null; readiness: Readiness | null; publish: PublishProgress;
  review: ReviewSummary | null;
}
export interface OrgSettings { monthlyAdBudgetCapCents: number | null; monthlyAdBudgetCap: number | null; monthlyCommittedCents: number; currency: string; privacyPolicyUrl: string | null; }
export interface StudioDraftRow { id: string; name: string; status: string; content: { language?: string; service?: string; variants?: { headline?: string }[] } | null; }
export interface ActionResult {
  campaign?: { id?: string; name?: string; policyWarning?: string | null; warnings?: string[] };
  publish?: { status: "COMPLETE" | "IN_PROGRESS"; progress: PublishProgress; warnings: string[] };
}

export type NoteTone = "success" | "warning" | "error";
/** Sonuç mesajı; `link` başarı mesajından ilgili yere götürür. */
export interface Note { tone: NoteTone; text: string; link?: { href: string; label: string; onClick?: () => void } }

const NOTE_CLASS: Record<NoteTone, string> = {
  success: "rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800",
  warning: "rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900",
  error: "rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800",
};

/** Kuruşlu tutar 2 ondalıkla gösterilir: harcama onayında yuvarlanmış bütçe yazılmaz ("€12,50", "€500"). */
export function money(cents: number | null | undefined, currency: string | null | undefined): string {
  return formatMoney(cents, currency ?? null, { precise: cents != null && !Number.isInteger(cents / 100) });
}
export function dailyBudgetCents(c: CampaignData): number | null {
  return c.budgetCents ?? c.dailyBudget ?? null;
}
/** Planlayıcı hedefi (MAX_*) ya da Meta'dan gelen hedef (OUTCOME_*) → kampanya hedefi adı. */
export function campaignObjectiveName(objective: string | null | undefined): string | null {
  if (!objective) return null;
  return (OBJECTIVE_LABEL as Record<string, string>)[objective] ?? objectiveLabel(objective);
}
export function methodName(method: string | null | undefined): string {
  if (!method) return "—";
  return (METHOD_LABEL as Record<string, string>)[method] ?? "Bilinmeyen yöntem";
}
export function languagesText(codes: readonly string[]): string {
  return codes.length ? codes.map((code) => languageName(code)).join(", ") : "—";
}
export function countriesText(codes: readonly string[]): string {
  return codes.length ? codes.map((code) => countryName(code)).join(", ") : "—";
}
export function progressText(p: PublishProgress): string {
  const parts = [`reklam seti ${p.adSets.published}/${p.adSets.total}`, `reklam ${p.ads.published}/${p.ads.expected}`];
  if (p.leadForms) parts.push(`Anında Form ${p.leadForms}`);
  return parts.join(" · ");
}
/** Sunucunun Türkçe hata metni; yanıt JSON değilse ya da ağ yoksa anlaşılır bir metin. */
export function errorText(e: unknown, fallback: string): string {
  if (e instanceof SyntaxError) return fallback;
  if (e instanceof TypeError) return "Sunucuya ulaşılamadı. Bağlantınızı kontrol edip tekrar deneyin.";
  return e instanceof Error && e.message ? e.message : fallback;
}
/** İşlem yanıtındaki uyarılar (orta risk, içerik, yükleme) sarı not olarak gösterilir. */
export function warningNotes(result: ActionResult | undefined): Note[] {
  const policy = result?.campaign?.policyWarning;
  return [
    ...(policy ? [`İçerik kontrolü: orta risk. ${policy}`] : []),
    ...(result?.campaign?.warnings ?? []),
    ...(result?.publish?.warnings ?? []),
  ]
    .filter(Boolean)
    .map((text) => ({ tone: "warning" as const, text }));
}
export function readAsDataUrl(file: File): Promise<string> {
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
export function Feedback({ notes, id, className = "mt-2" }: { notes: Note[]; id?: string; className?: string }) {
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
export function Chip({
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

function draftLabel(d: StudioDraftRow) {
  const lang = d.content?.language;
  return `${d.name} · ${lang ? languageName(lang) : "dil belirtilmemiş"}${d.content?.service ? ` · ${d.content.service}` : ""}`;
}

/** Onaylı reklam içeriği seçici (plan önizlemesi ve kampanyanın İçerik sekmesi). */
export function DraftPicker({
  drafts,
  selected,
  onToggle,
  neededLanguages,
  labelId,
}: {
  drafts: StudioDraftRow[];
  selected: string[];
  onToggle: (id: string) => void;
  neededLanguages: string[];
  labelId: string;
}) {
  if (drafts.length === 0)
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
        {drafts.map((d) => {
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

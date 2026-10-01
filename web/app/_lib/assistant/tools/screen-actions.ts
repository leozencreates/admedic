/**
 * Dış etki (R2) ve harcama (R3) araçları (ADR-0028 §2–3, Faz 4). R1 gibi iki adımdır, ama onay **yalnızca** ekrandaki
 * modal onay penceresinde gerçek bir tıklamayla verilir (`pending.ts` `source: "ui"`); sesli "evet",
 * `confirm_pending_action` ve R1 onay kartı bunları çalıştıramaz.
 * 1. `prepare`: kaydın **güncel** hâlini okur (yalnızca GET), ön koşulları denetler (yanlış durumdaki kampanya için
 *    bekleyen eylem oluşmaz), pencerede gösterilecek yapılandırılmış görünümü (`ConfirmationView`: kampanya adı, durum
 *    eski → yeni, bütçe eski → yeni para birimiyle, risk rozeti, R3'te harcama uyarısı) ve dondurulacak yükü üretir.
 * 2. `execute`: tıklamadan sonra, dondurulmuş yükle **tek** yazma isteği yapar. Bütçe ve öneri araçları yazmadan önce
 *    kaydı yeniden okur; kullanıcının gördüğü değer bu arada değiştiyse yazmaz (pencere eski bir tutarı onaylatmasın).
 *
 * Asistan yetki sınırı değildir: harcama yetkisi ve aylık tavan sunucuda (`requireSpendAuthority`,
 * `assertWithinMonthlyCap`) denetlenir; istemci yalnızca R3'ü `canApproveSpend` false iken hiç bağlamaz. Uç, yöntem ve
 * gövdeler route kodundan doğrulandı (2026-10-01): `campaigns/:id/publish` POST `{action}` (PUBLISH yalnızca APPROVED,
 * PAUSE yalnızca ACTIVE, ARCHIVE ACTIVE/PUBLISHED_PAUSED ya da yarım yükleme, ACTIVATE yalnızca PUBLISHED_PAUSED +
 * harcama yetkisi + tavan), `campaigns/:id/budget` PATCH `{dailyBudget}` (ana birim; artış harcama yetkisi + tavan
 * ister, azalış serbest), `meta/review-sync` POST `{campaignId?}`, `recommendations/:id/apply` POST gövdesiz (yalnızca
 * APPROVED; hedef `action.campaignId`; BUDGET_INCREASE harcama yetkisi ister).
 *
 * Kampanya adı lead kişisel verisi değildir; özette ve pencerede gösterilir (yine de e-posta/telefon maskelenir).
 */
import { formatMoney } from "../../format";
import { t, type Language } from "../../i18n";
import { campaignWorkflowStyle } from "../../labels";
import { isApplicableRecommendation, RECOMMENDATION_KIND_LABEL, recommendationKind } from "../../recommendation-kinds";
import type { ConfirmationField, ConfirmationView } from "../pending";
import {
  sanitizeAppliedRecommendation,
  sanitizeBudgetChange,
  sanitizeCampaignAction,
  sanitizeReviewSync,
  scrubText,
} from "../sanitize";
import { fill, type ActionHandler } from "./actions";
import { json, ToolInputError, type ToolContext } from "./context";

/** Ön koşul iletileri (ajana olduğu gibi gider; kimlik ve kişisel veri içermez). */
export const SCREEN_ACTION_MESSAGES = {
  notApproved: "Kampanya henüz onaylanmadı; yalnızca onaylanmış kampanya Meta'ya yüklenebilir. Onay Onaylar sayfasında verilir.",
  alreadyPublished: "Kampanya zaten Meta'ya yüklenmiş.",
  notReady: "Kampanya yüklemeye hazır değil; eksikleri kampanya sayfasında tamamlayın.",
  notActive: "Yalnızca yayındaki (etkin) kampanya duraklatılabilir.",
  notArchivable: "Yalnızca yayındaki ya da Meta'ya yüklenmiş kampanya arşivlenebilir.",
  notActivatable: "Yalnızca Meta'ya yüklenmiş ve duraklatılmış kampanya etkinleştirilebilir.",
  notPublished: "Kampanya Meta'da yayınlanmamış; inceleme durumu yenilenemez.",
  archived: "Arşivlenmiş ya da silinmiş kampanyanın bütçesi değiştirilemez.",
  lifetimeBudget: "Bu kampanyanın toplam (ömür boyu) bütçesi var; yalnızca günlük bütçe değiştirilebilir.",
  sameBudget: "Günlük bütçe zaten bu tutarda; değişiklik yok.",
  budgetTooSmall: "Günlük bütçe en az 0,01 olmalı.",
  notDecrease: "Yeni tutar mevcut günlük bütçeden ({current}) yüksek; bu bir artıştır. increase_budget kullanın.",
  notIncrease: "Yeni tutar mevcut günlük bütçeden ({current}) düşük; bu bir azaltmadır. decrease_budget kullanın.",
  budgetChanged: "Kampanyanın bütçesi bu sırada değişti; işlem yapılmadı. Güncel bütçeyi okuyup yeniden isteyin.",
  recommendationApplied: "Bu öneri zaten uygulanmış.",
  recommendationNotApproved:
    "Öneri henüz onaylanmadı; yalnızca onaylanmış öneri uygulanabilir. Onay sesle verilmez; Onaylar sayfasını açın.",
  recommendationNotApplicable: "Bu öneri türü otomatik uygulanamaz; değerlendirme notu olarak kalır.",
  recommendationNoTarget: "Önerinin hedef kampanyası seçilmemiş; hedefi Öneriler sayfasında seçin.",
  recommendationNoBudget: "Hedef kampanyanın günlük bütçesi tanımlı değil; önce bütçe girin.",
  recommendationInvalid: "Önerideki bütçe oranı geçersiz; öneri uygulanamaz. Bütçeyi kampanya sayfasından değiştirin.",
  recommendationChanged: "Öneri ya da hedef kampanyanın bütçesi bu sırada değişti; işlem yapılmadı. Yeniden isteyin.",
  unreadable: "Kayıt okunamadı. Sayfayı yenileyip tekrar deneyin.",
} as const;

/** Bir ayda sayılan gün (spend-cap.ts `MONTH_DAYS` ile aynı; sunucu modülü içe aktarılmaz). */
const MONTH_DAYS = 30;

const enc = encodeURIComponent;

function rec(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Minor unit → para birimiyle biçimli tutar (ADR-0011); kuruş varsa 2 ondalık. */
export function formatCents(cents: number, currency: string | null): string {
  return formatMoney(cents, currency, { precise: !Number.isInteger(cents / 100) });
}

interface CampaignState {
  id: string;
  name: string;
  workflowStatus: string;
  status: string | null;
  /** Günlük bütçe, minor unit. */
  dailyCents: number | null;
  currency: string | null;
  lifetime: boolean;
  metaCampaignId: string | null;
  readinessReady: boolean | null;
}

/** `GET /api/campaigns/:id` → bu araçların ihtiyaç duyduğu alanlar (tenant kapsamı sunucuda). */
async function loadCampaign(ctx: ToolContext, id: string): Promise<CampaignState> {
  const c = rec(rec(await ctx.api(`/api/campaigns/${enc(id)}`)).campaign);
  if (typeof c.workflowStatus !== "string") throw new ToolInputError(SCREEN_ACTION_MESSAGES.unreadable);
  const cents = typeof c.budgetCents === "number" ? c.budgetCents : typeof c.dailyBudget === "number" ? c.dailyBudget : null;
  const readiness = rec(c.readiness);
  return {
    id,
    name: scrubText(c.name, 100) ?? "",
    workflowStatus: c.workflowStatus,
    status: typeof c.status === "string" ? c.status : null,
    dailyCents: cents,
    currency: typeof c.currency === "string" ? c.currency : null,
    lifetime: c.budgetType === "LIFETIME" || (c.lifetimeBudget !== null && c.lifetimeBudget !== undefined),
    metaCampaignId: typeof c.metaCampaignId === "string" && c.metaCampaignId ? c.metaCampaignId : null,
    readinessReady: typeof readiness.ready === "boolean" ? readiness.ready : null,
  };
}

function statusLabel(workflowStatus: string): string {
  return campaignWorkflowStyle(workflowStatus).label;
}

function view(
  lang: Language,
  input: {
    risk: "R2" | "R3";
    title: string;
    campaignName?: string;
    fields: ConfirmationField[];
    notes?: string[];
    spend?: boolean;
  },
): ConfirmationView {
  return {
    title: input.title,
    ...(input.campaignName ? { campaignName: input.campaignName } : {}),
    fields: input.fields,
    risk: input.risk,
    riskLabel: t(`assistant.screen.risk.${input.risk}`, lang),
    ...(input.spend ? { spendWarning: t("assistant.screen.spendWarning", lang) } : {}),
    ...(input.notes?.length ? { notes: input.notes } : {}),
  };
}

function budgetFields(lang: Language, currency: string | null, beforeCents: number | null, afterCents: number): ConfirmationField[] {
  return [
    {
      label: t("assistant.screen.field.dailyBudget", lang),
      ...(beforeCents !== null ? { before: formatCents(beforeCents, currency) } : {}),
      after: formatCents(afterCents, currency),
    },
    {
      label: t("assistant.screen.field.monthlyBudget", lang),
      ...(beforeCents !== null ? { before: formatCents(beforeCents * MONTH_DAYS, currency) } : {}),
      after: formatCents(afterCents * MONTH_DAYS, currency),
    },
  ];
}

function statusField(lang: Language, before: string, after: string): ConfirmationField {
  return { label: t("assistant.screen.field.status", lang), before: statusLabel(before), after: statusLabel(after) };
}

function ok(value: Record<string, unknown>): string {
  return json({ ok: true, ...value });
}

/** PUBLISH / PAUSE / ARCHIVE / ACTIVATE: aynı uç, farklı ön koşul ve görünüm. */
function campaignAction(spec: {
  action: "PUBLISH" | "PAUSE" | "ARCHIVE" | "ACTIVATE";
  risk: "R2" | "R3";
  key: "publish" | "pause" | "archive" | "activate";
  check(c: CampaignState): void;
  target: string;
  notes?: (lang: Language) => string[];
}): ActionHandler {
  return {
    async prepare(params, ctx) {
      const id = ctx.refs.resolve(params.ref, "campaign");
      const c = await loadCampaign(ctx, id);
      spec.check(c);
      const fields = [statusField(ctx.lang, c.workflowStatus, spec.target)];
      if (spec.action === "ACTIVATE" && c.dailyCents !== null) fields.push(...budgetFields(ctx.lang, c.currency, null, c.dailyCents));
      return {
        summary: fill(t(`assistant.screen.${spec.key}.summary`, ctx.lang), {
          name: c.name,
          budget: c.dailyCents !== null ? formatCents(c.dailyCents, c.currency) : "—",
        }),
        // Harcamayı başlatan eylemde ekranda gösterilen bütçe dondurulur; tıklamadan önce yeniden denetlenir.
        payload: { campaignId: id, action: spec.action, ...(spec.action === "ACTIVATE" ? { expectedCurrentCents: c.dailyCents } : {}) },
        entityId: id,
        confirmation: view(ctx.lang, {
          risk: spec.risk,
          title: t(`assistant.screen.${spec.key}.title`, ctx.lang),
          campaignName: c.name,
          fields,
          notes: spec.notes?.(ctx.lang),
          spend: spec.risk === "R3",
        }),
      };
    },
    async execute(payload, ctx) {
      const id = String(payload.campaignId);
      if (payload.action === "ACTIVATE") {
        const fresh = await loadCampaign(ctx, id);
        spec.check(fresh);
        if (fresh.dailyCents !== (payload.expectedCurrentCents ?? null)) throw new ToolInputError(SCREEN_ACTION_MESSAGES.budgetChanged);
      }
      const data = await ctx.api(`/api/campaigns/${enc(id)}/publish`, "POST", { action: payload.action });
      const result = sanitizeCampaignAction(data, ctx.refs);
      return {
        result: ok({
          ...result,
          ...(result.publishStatus === "IN_PROGRESS"
            ? { next: "Yükleme sürüyor; kalan adımlar için kampanyanın Yükleme sekmesini açmayı öner." }
            : {}),
        }),
        entityId: id,
      };
    },
  };
}

/** Bütçe azaltma (R2) ve artırma (R3): yön hazırlıkta taze bütçeye göre, çalıştırmadan önce yeniden denetlenir. */
function budgetAction(direction: "down" | "up"): ActionHandler {
  return {
    async prepare(params, ctx) {
      const id = ctx.refs.resolve(params.ref, "campaign");
      const c = await loadCampaign(ctx, id);
      if (c.workflowStatus === "ARCHIVED" || c.status === "DELETED") throw new ToolInputError(SCREEN_ACTION_MESSAGES.archived);
      if (c.lifetime) throw new ToolInputError(SCREEN_ACTION_MESSAGES.lifetimeBudget);
      const current = c.dailyCents ?? 0;
      const next = Math.round(Number(params.dailyBudget) * 100);
      if (!Number.isFinite(next) || next < 1) throw new ToolInputError(SCREEN_ACTION_MESSAGES.budgetTooSmall);
      if (next === current) throw new ToolInputError(SCREEN_ACTION_MESSAGES.sameBudget);
      const currentText = formatCents(current, c.currency);
      if (direction === "down" && next > current) throw new ToolInputError(fill(SCREEN_ACTION_MESSAGES.notDecrease, { current: currentText }));
      if (direction === "up" && next < current) throw new ToolInputError(fill(SCREEN_ACTION_MESSAGES.notIncrease, { current: currentText }));
      const key = direction === "down" ? "budgetDown" : "budgetUp";
      return {
        summary: fill(t(`assistant.screen.${key}.summary`, ctx.lang), {
          name: c.name,
          before: currentText,
          after: formatCents(next, c.currency),
        }),
        // Gövde ana birimle gider (sunucu ×100 yapar); beklenen mevcut bütçe yazmadan önce yeniden denetlenir.
        payload: { campaignId: id, dailyBudget: next / 100, expectedCurrentCents: current, currency: c.currency },
        entityId: id,
        confirmation: view(ctx.lang, {
          risk: direction === "down" ? "R2" : "R3",
          title: t(`assistant.screen.${key}.title`, ctx.lang),
          campaignName: c.name,
          fields: budgetFields(ctx.lang, c.currency, current, next),
          spend: direction === "up",
        }),
      };
    },
    async execute(payload, ctx) {
      const id = String(payload.campaignId);
      const fresh = await loadCampaign(ctx, id);
      if ((fresh.dailyCents ?? 0) !== payload.expectedCurrentCents) throw new ToolInputError(SCREEN_ACTION_MESSAGES.budgetChanged);
      const data = await ctx.api(`/api/campaigns/${enc(id)}/budget`, "PATCH", { dailyBudget: payload.dailyBudget });
      const currency = typeof payload.currency === "string" ? payload.currency : null;
      return { result: ok(sanitizeBudgetChange(data, ctx.refs, currency)), entityId: id };
    },
  };
}

interface RecommendationState {
  kind: string;
  targetCampaignId: string;
  /** Önerinin `action` alanı (oran hesabı için). */
  action: Record<string, unknown>;
}

async function loadApprovedRecommendation(ctx: ToolContext, id: string): Promise<RecommendationState> {
  const r = rec(rec(await ctx.api(`/api/recommendations/${enc(id)}`)).recommendation);
  if (typeof r.status !== "string") throw new ToolInputError(SCREEN_ACTION_MESSAGES.unreadable);
  if (r.status === "APPLIED") throw new ToolInputError(SCREEN_ACTION_MESSAGES.recommendationApplied);
  if (r.status !== "APPROVED") throw new ToolInputError(SCREEN_ACTION_MESSAGES.recommendationNotApproved);
  const action = rec(r.action);
  const kind = recommendationKind({ type: typeof r.type === "string" ? r.type : "", action });
  if (!isApplicableRecommendation(kind)) throw new ToolInputError(SCREEN_ACTION_MESSAGES.recommendationNotApplicable);
  const target = typeof action.campaignId === "string" ? action.campaignId.trim() : "";
  if (!target) throw new ToolInputError(SCREEN_ACTION_MESSAGES.recommendationNoTarget);
  return { kind, targetCampaignId: target, action };
}

/** `recommendations/[id]/apply` ile aynı hesap (yalnızca pencerede gösterim için; asıl hesap sunucuda). */
export function recommendedBudgetCents(kind: string, action: Record<string, unknown>, currentCents: number): number | null {
  if (kind === "BUDGET_INCREASE") return Math.round(currentCents * 1.2);
  if (kind === "BUDGET_REALLOCATION") {
    const split = Number((Array.isArray(action.budgetSplit) ? action.budgetSplit[0] : undefined) ?? 70);
    if (!Number.isFinite(split) || split <= 0 || split > 100) return null;
    return Math.round((currentCents * split) / 100);
  }
  const pct = Number(action.pct ?? 20);
  if (!Number.isFinite(pct) || pct <= 0 || pct >= 100) return null;
  return Math.round(currentCents * (1 - pct / 100));
}

export const screenActionHandlers: Record<string, ActionHandler> = {
  publish_campaign_paused: campaignAction({
    action: "PUBLISH",
    risk: "R2",
    key: "publish",
    target: "PUBLISHED_PAUSED",
    check(c) {
      if (c.workflowStatus === "PUBLISHED_PAUSED" || c.workflowStatus === "ACTIVE")
        throw new ToolInputError(SCREEN_ACTION_MESSAGES.alreadyPublished);
      if (c.workflowStatus !== "APPROVED") throw new ToolInputError(SCREEN_ACTION_MESSAGES.notApproved);
      if (c.readinessReady === false) throw new ToolInputError(SCREEN_ACTION_MESSAGES.notReady);
    },
    notes: (lang) => [t("assistant.screen.publish.note", lang)],
  }),

  pause_campaign: campaignAction({
    action: "PAUSE",
    risk: "R2",
    key: "pause",
    target: "PUBLISHED_PAUSED",
    check(c) {
      if (c.workflowStatus !== "ACTIVE" || !c.metaCampaignId) throw new ToolInputError(SCREEN_ACTION_MESSAGES.notActive);
    },
  }),

  archive_campaign: campaignAction({
    action: "ARCHIVE",
    risk: "R2",
    key: "archive",
    target: "ARCHIVED",
    check(c) {
      const published = c.workflowStatus === "ACTIVE" || c.workflowStatus === "PUBLISHED_PAUSED";
      const partial = c.workflowStatus === "APPROVED" && Boolean(c.metaCampaignId);
      if ((!published && !partial) || !c.metaCampaignId) throw new ToolInputError(SCREEN_ACTION_MESSAGES.notArchivable);
    },
    notes: (lang) => [t("assistant.screen.archive.note", lang)],
  }),

  activate_campaign: campaignAction({
    action: "ACTIVATE",
    risk: "R3",
    key: "activate",
    target: "ACTIVE",
    check(c) {
      if (c.workflowStatus !== "PUBLISHED_PAUSED" || !c.metaCampaignId) throw new ToolInputError(SCREEN_ACTION_MESSAGES.notActivatable);
    },
  }),

  decrease_budget: budgetAction("down"),
  increase_budget: budgetAction("up"),

  sync_meta_review: {
    async prepare(params, ctx) {
      if (typeof params.ref !== "string") {
        return {
          summary: t("assistant.screen.reviewSync.summaryAll", ctx.lang),
          payload: {},
          confirmation: view(ctx.lang, {
            risk: "R2",
            title: t("assistant.screen.reviewSync.title", ctx.lang),
            fields: [{ label: t("assistant.screen.field.scope", ctx.lang), after: t("assistant.screen.scope.allPublished", ctx.lang) }],
            notes: [t("assistant.screen.reviewSync.note", ctx.lang)],
          }),
        };
      }
      const id = ctx.refs.resolve(params.ref, "campaign");
      const c = await loadCampaign(ctx, id);
      if (!c.metaCampaignId) throw new ToolInputError(SCREEN_ACTION_MESSAGES.notPublished);
      return {
        summary: fill(t("assistant.screen.reviewSync.summary", ctx.lang), { name: c.name }),
        payload: { campaignId: id },
        entityId: id,
        confirmation: view(ctx.lang, {
          risk: "R2",
          title: t("assistant.screen.reviewSync.title", ctx.lang),
          campaignName: c.name,
          fields: [{ label: t("assistant.screen.field.status", ctx.lang), after: statusLabel(c.workflowStatus) }],
          notes: [t("assistant.screen.reviewSync.note", ctx.lang)],
        }),
      };
    },
    async execute(payload, ctx) {
      const id = typeof payload.campaignId === "string" ? payload.campaignId : undefined;
      const data = await ctx.api("/api/meta/review-sync", "POST", id ? { campaignId: id } : {});
      return { result: ok(sanitizeReviewSync(data, ctx.refs)), ...(id ? { entityId: id } : {}) };
    },
  },

  apply_recommendation: {
    async prepare(params, ctx) {
      const id = ctx.refs.resolve(params.ref, "recommendation");
      const r = await loadApprovedRecommendation(ctx, id);
      const c = await loadCampaign(ctx, r.targetCampaignId);
      if (c.dailyCents === null || c.dailyCents <= 0) throw new ToolInputError(SCREEN_ACTION_MESSAGES.recommendationNoBudget);
      const next = recommendedBudgetCents(r.kind, r.action, c.dailyCents);
      if (next === null || next < 1) throw new ToolInputError(SCREEN_ACTION_MESSAGES.recommendationInvalid);
      const increase = next > c.dailyCents;
      return {
        summary: fill(t("assistant.screen.applyRec.summary", ctx.lang), {
          ref: String(params.ref),
          name: c.name,
          before: formatCents(c.dailyCents, c.currency),
          after: formatCents(next, c.currency),
        }),
        payload: { recommendationId: id, campaignId: r.targetCampaignId, expectedCurrentCents: c.dailyCents },
        entityId: id,
        confirmation: view(ctx.lang, {
          risk: "R3",
          title: t("assistant.screen.applyRec.title", ctx.lang),
          campaignName: c.name,
          fields: [
            { label: t("assistant.screen.field.recommendation", ctx.lang), after: String(params.ref) },
            { label: t("assistant.screen.field.recommendationKind", ctx.lang), after: RECOMMENDATION_KIND_LABEL[r.kind] ?? r.kind },
            ...budgetFields(ctx.lang, c.currency, c.dailyCents, next),
          ],
          // Uyarı yalnızca artışta; azaltan öneri de R3 aracıdır (araç düzeyinde tek risk), ama harcamayı artırmaz.
          spend: increase,
        }),
      };
    },
    async execute(payload, ctx) {
      const id = String(payload.recommendationId);
      // Kullanıcının gördüğü hedef ve bütçe hâlâ geçerli mi? Değiştiyse yazma yok.
      const r = await loadApprovedRecommendation(ctx, id);
      if (r.targetCampaignId !== payload.campaignId) throw new ToolInputError(SCREEN_ACTION_MESSAGES.recommendationChanged);
      const c = await loadCampaign(ctx, r.targetCampaignId);
      if (c.dailyCents !== payload.expectedCurrentCents) throw new ToolInputError(SCREEN_ACTION_MESSAGES.recommendationChanged);
      // Gövdesiz: hedef sunucuda önerinin kendi `action.campaignId` alanından okunur.
      const data = await ctx.api(`/api/recommendations/${enc(id)}/apply`, "POST");
      return { result: ok(sanitizeAppliedRecommendation(data, ctx.refs, id)), entityId: id };
    },
  },
};

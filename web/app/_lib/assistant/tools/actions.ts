/**
 * İç yazma araçları (R1, ADR-0028 §3 "İç yazma", Faz 3). Her araç iki adımdır:
 * 1. `prepare`: parametreleri (ref'ler dahil) çözer ve doğrular, kullanıcıya okunacak kısa Türkçe özeti ve onaylanınca
 *    gönderilecek **yükü** (payload) üretir. Yazma isteği yapmaz. Yük `pending.ts` içinde dondurulur.
 * 2. `execute`: kullanıcı onayladıktan sonra, dondurulmuş yükle tek bir yazma isteği yapar ve sonucu `sanitize.ts`
 *    ile kişisel veriden arındırır.
 *
 * Yetki her uçta sunucuda yeniden denetlenir (asistan yetki sınırı değildir). Uç ve gövdeler ilgili route kodundan
 * doğrulandı (2026-10-01): `campaigns` POST, `campaigns/:id/submit` POST, `alerts/:id` PATCH, `leads/:id` PATCH,
 * `studio/generate` POST, `studio` POST, `studio/:id` PATCH action=submit, `recommendations/:id` PATCH status=PENDING,
 * `leads/refetch` POST; Faz 5: `experiments/:id` GET + PATCH (`studio-service.ts` `updateExperiment`, EDIT_ROLES).
 * Öneri **reddi** R4'tür (onay/ret kararı) ve araç olarak yoktur.
 * Klinik ve hizmet düzenleme (Faz 5) bilerek araç değildir: alanları hastaya giden kanallara akar (hasta yanıt
 * asistanı klinik adı, hizmetler, diller ve marka tonunu; giden arama ajanı klinik adını; reklam üretimi marka tonu,
 * hizmetler ve yasaklı ifadeleri; politika denetimi yasaklı ifadeleri kullanır), hizmet fiyatı ve "başlangıç fiyatını
 * göster" hastaya yönelik fiyat bilgisidir ve klinik kaydı iletişim bilgisi taşır. ADR-0028 "Faz 5".
 *
 * Özetler ve sonuçlar lead adı, iletişim bilgisi, mesaj ya da sağlık verisi içermez; lead yalnızca ref'iyle anılır.
 * Kayıp nedeni serbest metin değil, hazır listeden (`LOST_REASONS`) seçilir.
 *
 * Faz 4: `update_lead_status` R2'dir (durum değişikliği Meta'ya CAPI dönüşümü gönderebilir); yalnızca ekrandaki onay
 * penceresinden onaylanır ve bu yüzden bir `confirmation` görünümü üretir. R2/R3 kampanya araçları `screen-actions.ts`.
 */
import { OBJECTIVE_LABEL, type PlanObjective } from "../../campaign-plan";
import { formatLeadStatus, t } from "../../i18n";
import type { ConfirmationView } from "../pending";
import {
  sanitizeCreatedCampaign,
  sanitizeExperimentMetrics,
  sanitizeGeneratedCopy,
  sanitizeRecommendation,
  sanitizeRefetchSummary,
  sanitizeStudioDraft,
  sanitizeSubmittedCampaign,
  sanitizeUpdatedAlert,
  scrubText,
} from "../sanitize";
import { json, ToolInputError, type ToolContext, type ToolOutput } from "./context";

/** `prepare` çıktısı: okunacak özet, onaylanınca gönderilecek yük, denetim kimliği ve (R2/R3) ekran onay görünümü. */
export interface PreparedAction {
  summary: string;
  payload: Record<string, unknown>;
  entityId?: string;
  /** R2/R3 için zorunlu: ekrandaki modal onay penceresinin içeriği. */
  confirmation?: ConfirmationView;
}

export interface ActionHandler {
  prepare(params: Record<string, unknown>, ctx: ToolContext): Promise<PreparedAction>;
  execute(payload: Readonly<Record<string, unknown>>, ctx: ToolContext): Promise<ToolOutput>;
}

/** `{ad}` yer tutucularını doldurur. */
export function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, key: string) => (key in vars ? String(vars[key]) : m));
}

function ok(value: Record<string, unknown>): string {
  return json({ ok: true, ...value });
}

const enc = encodeURIComponent;

function number(value: number, lang: ToolContext["lang"]): string {
  return new Intl.NumberFormat(lang === "en" ? "en-US" : "tr-TR", { maximumFractionDigits: 2 }).format(value);
}

function rec(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Konuşmada tutulacak (dondurulmuş) kopya. */
function frozenCopy(value: unknown): Readonly<Record<string, unknown>> {
  const copy = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  const freeze = (v: unknown) => {
    if (v && typeof v === "object") {
      for (const x of Object.values(v)) freeze(x);
      Object.freeze(v);
    }
  };
  freeze(copy);
  return copy;
}

export const actionHandlers: Record<string, ActionHandler> = {
  create_campaign_draft: {
    async prepare(params, ctx) {
      const name = String(params.title).trim();
      const budget = Number(params.dailyBudget);
      const objective = (typeof params.objective === "string" ? params.objective : "MAX_ROAS") as PlanObjective;
      return {
        summary: fill(t("assistant.action.createCampaign", ctx.lang), {
          title: scrubText(name, 100) ?? "",
          budget: number(budget, ctx.lang),
          objective: OBJECTIVE_LABEL[objective] ?? objective,
        }),
        // Yalnızca ad, bütçe ve hedef: planlı ad set, içerik ve hedefleme ekranda planlayıcıyla eklenir.
        payload: { name, budget, objective },
      };
    },
    async execute(payload, ctx) {
      const data = await ctx.api("/api/campaigns", "POST", { name: payload.name, budget: payload.budget, objective: payload.objective });
      const id = rec(rec(data).campaign).id;
      return { result: ok(sanitizeCreatedCampaign(data, ctx.refs)), entityId: typeof id === "string" ? id : undefined };
    },
  },

  submit_campaign_for_review: {
    async prepare(params, ctx) {
      const id = ctx.refs.resolve(params.ref, "campaign");
      return {
        summary: fill(t("assistant.action.submitCampaign", ctx.lang), { ref: String(params.ref) }),
        payload: { campaignId: id },
        entityId: id,
      };
    },
    async execute(payload, ctx) {
      const id = String(payload.campaignId);
      const data = await ctx.api(`/api/campaigns/${enc(id)}/submit`, "POST");
      return { result: ok(sanitizeSubmittedCampaign(data, ctx.refs)), entityId: id };
    },
  },

  update_alert: {
    async prepare(params, ctx) {
      const id = ctx.refs.resolve(params.ref, "alert");
      const status = params.status === "RESOLVED" ? "RESOLVED" : "ACKED";
      return {
        summary: fill(t(status === "RESOLVED" ? "assistant.action.alertResolved" : "assistant.action.alertAcked", ctx.lang), {
          ref: String(params.ref),
        }),
        payload: { alertId: id, status },
        entityId: id,
      };
    },
    async execute(payload, ctx) {
      const id = String(payload.alertId);
      const data = await ctx.api(`/api/alerts/${enc(id)}`, "PATCH", { status: payload.status });
      return { result: ok(sanitizeUpdatedAlert(data, ctx.refs)), entityId: id };
    },
  },

  update_lead_status: {
    async prepare(params, ctx) {
      const id = ctx.refs.resolve(params.ref, "lead");
      const status = String(params.status);
      const reason = typeof params.lostReason === "string" ? params.lostReason : undefined;
      if (status === "LOST" && !reason)
        throw new ToolInputError("Lead'i kaybedildi olarak işaretlemek için kayıp nedeni gerekir; kullanıcıya listeden nedeni sorun.");
      if (status !== "LOST" && reason) throw new ToolInputError("Kayıp nedeni yalnızca lead kaybedildi olarak işaretlenirken verilir.");
      return {
        summary:
          status === "LOST"
            ? fill(t("assistant.action.leadLost", ctx.lang), { ref: String(params.ref), reason: reason! })
            : fill(t("assistant.action.leadStatus", ctx.lang), { ref: String(params.ref), status: formatLeadStatus(status, ctx.lang) }),
        payload: { leadId: id, status, ...(reason ? { lostReason: reason } : {}) },
        entityId: id,
        // Lead yalnızca ref'iyle anılır (ad, iletişim bilgisi ya da sağlık verisi pencerede de yok).
        confirmation: {
          title: t("assistant.screen.leadStatus.title", ctx.lang),
          fields: [
            { label: t("assistant.screen.field.lead", ctx.lang), after: String(params.ref) },
            { label: t("assistant.screen.field.leadStatus", ctx.lang), after: formatLeadStatus(status, ctx.lang) },
            ...(reason ? [{ label: t("assistant.screen.field.lostReason", ctx.lang), after: reason }] : []),
          ],
          risk: "R2",
          riskLabel: t("assistant.screen.risk.R2", ctx.lang),
          notes: [t("assistant.screen.leadStatus.note", ctx.lang)],
        },
      };
    },
    async execute(payload, ctx) {
      const id = String(payload.leadId);
      await ctx.api(`/api/leads/${enc(id)}`, "PATCH", {
        status: payload.status,
        ...(payload.lostReason ? { lostReason: payload.lostReason } : {}),
      });
      // Yanıttaki dönüşüm (CAPI) ayrıntısı ajana gitmez.
      return { result: ok({ ref: ctx.refs.ref("lead", id), status: payload.status }), entityId: id };
    },
  },

  generate_ad_copy: {
    async prepare(params, ctx) {
      const brief = {
        clinic: String(params.clinic).trim(),
        service: String(params.service).trim(),
        market: String(params.market).trim(),
        language: String(params.language),
        budget: Number(params.budget),
        duration: Number(params.duration),
      };
      return {
        summary: fill(t("assistant.action.generateCopy", ctx.lang), {
          clinic: scrubText(brief.clinic, 100) ?? "",
          service: scrubText(brief.service, 100) ?? "",
          market: scrubText(brief.market, 80) ?? "",
          language: brief.language,
        }),
        payload: brief,
      };
    },
    async execute(payload, ctx) {
      const data = await ctx.api("/api/studio/generate", "POST", { ...payload });
      const content = rec(data).content;
      // Tam içerik yalnızca tarayıcı belleğinde kalır; `save_studio_draft` onu kaydeder.
      ctx.memory.generatedCopy = content && typeof content === "object" ? frozenCopy(content) : null;
      return {
        result: ok({
          ...sanitizeGeneratedCopy(data),
          next: "Kullanıcı kaydetmek isterse save_studio_draft çağır.",
        }),
      };
    },
  },

  save_studio_draft: {
    async prepare(_params, ctx) {
      const content = ctx.memory.generatedCopy;
      if (!content) throw new ToolInputError("Kaydedilecek reklam metni yok. Önce generate_ad_copy ile metin üretin.");
      return {
        summary: fill(t("assistant.action.saveDraft", ctx.lang), {
          name: `${scrubText(content.clinic, 100) ?? ""} · ${scrubText(content.service, 100) ?? ""}`,
        }),
        payload: { content: content as Record<string, unknown> },
      };
    },
    async execute(payload, ctx) {
      const data = await ctx.api("/api/studio", "POST", { content: payload.content });
      const id = rec(rec(data).draft).id;
      return { result: ok(sanitizeStudioDraft(data, ctx.refs)), entityId: typeof id === "string" ? id : undefined };
    },
  },

  submit_studio_draft: {
    async prepare(params, ctx) {
      const id = ctx.refs.resolve(params.ref, "studio");
      // Sürüm onay anında değil şimdi okunur ve dondurulur: taslak bu arada değişirse sunucu 409 döner (kullanıcının
      // onayladığından farklı bir içerik onaya gitmez).
      const draft = rec(rec(await ctx.api(`/api/studio/${enc(id)}`)).draft);
      if (typeof draft.version !== "number") throw new ToolInputError("Taslak okunamadı. Sayfayı yenileyip tekrar deneyin.");
      if (draft.status !== "DRAFT" && draft.status !== "REJECTED")
        throw new ToolInputError("Bu taslak zaten incelemede ya da onaylı; yeniden gönderilemez.");
      return {
        summary: fill(t("assistant.action.submitDraft", ctx.lang), { ref: String(params.ref) }),
        payload: { draftId: id, version: draft.version },
        entityId: id,
      };
    },
    async execute(payload, ctx) {
      const id = String(payload.draftId);
      // Orta risk uyarısı (`acknowledgeWarning`) sesle onaylanmaz: sunucu 422 döner, kullanıcı ekrandan gönderir.
      const data = await ctx.api(`/api/studio/${enc(id)}`, "PATCH", { action: "submit", version: payload.version });
      return { result: ok(sanitizeStudioDraft(data, ctx.refs)), entityId: id };
    },
  },

  submit_recommendation_for_review: {
    async prepare(params, ctx) {
      const id = ctx.refs.resolve(params.ref, "recommendation");
      return {
        summary: fill(t("assistant.action.submitRecommendation", ctx.lang), { ref: String(params.ref) }),
        payload: { recommendationId: id },
        entityId: id,
      };
    },
    async execute(payload, ctx) {
      const id = String(payload.recommendationId);
      const data = await ctx.api(`/api/recommendations/${enc(id)}`, "PATCH", { status: "PENDING" });
      const r = sanitizeRecommendation(rec(data).recommendation, ctx.refs);
      return { result: ok({ ref: r.ref, status: r.status }), entityId: id };
    },
  },

  /**
   * Faz 5: A/B testinin bir varyantına manuel ölçüm (harcama, tıklama, lead) yazar. Deney ölçümü yalnızca iç veridir:
   * Meta'ya, hastaya ya da harcamaya etkisi yoktur (`experiments/:id/sync` otomatik ölçüm yapmaz) → R1. Hazırlarken
   * test taze okunur: sürüm, diğer varyantın metrikleri, gün sayısı ve durum dondurulur. Sunucu sürüm uyuşmazlığında
   * 409 döner (bu arada değiştiyse yazılmaz); durum değişmez (test başlatma/tamamlama ekrandan).
   */
  update_experiment_metrics: {
    async prepare(params, ctx) {
      const id = ctx.refs.resolve(params.ref, "experiment");
      const variant = params.variant === "B" ? "B" : "A";
      const exp = rec(rec(await ctx.api(`/api/experiments/${enc(id)}`)).experiment);
      if (typeof exp.version !== "number") throw new ToolInputError("A/B testi okunamadı. Sayfayı yenileyip tekrar deneyin.");
      if (exp.status !== "DRAFT" && exp.status !== "RUNNING")
        throw new ToolInputError("Tamamlanan A/B testinin metrikleri değiştirilemez.");
      const spend = Number(params.spend);
      const clicks = Number(params.clicks);
      const leads = Number(params.leads);
      if (leads > clicks) throw new ToolInputError("Lead sayısı tıklama sayısından büyük olamaz.");
      const current = typeof exp.elapsedDays === "number" ? exp.elapsedDays : 0;
      const elapsedDays = typeof params.elapsedDays === "number" ? params.elapsedDays : current;
      if (elapsedDays < current) throw new ToolInputError(`Geçen gün sayısı azaltılamaz (şu an ${current}).`);
      // Diğer varyantın kayıtlı metrikleri olduğu gibi korunur; okunamıyorsa yazılmaz (sıfırlanmasın).
      const metrics = sanitizeExperimentMetrics(exp.metrics).map((m) =>
        m.variant === variant ? { spend, clicks, leads } : { spend: m.spend, clicks: m.clicks, leads: m.leads },
      );
      if (metrics.some((m) => m.spend === null || m.clicks === null || m.leads === null))
        throw new ToolInputError("Diğer varyantın metrikleri okunamadı. Metrikleri A/B testi sayfasından girin.");
      return {
        summary: fill(t("assistant.action.experimentMetrics", ctx.lang), {
          ref: String(params.ref),
          variant,
          spend: number(spend, ctx.lang),
          clicks: number(clicks, ctx.lang),
          leads: number(leads, ctx.lang),
          days: elapsedDays,
        }),
        payload: { experimentId: id, variant, version: exp.version, metrics, elapsedDays, status: exp.status },
        entityId: id,
      };
    },
    async execute(payload, ctx) {
      const id = String(payload.experimentId);
      await ctx.api(`/api/experiments/${enc(id)}`, "PATCH", {
        version: payload.version,
        metrics: payload.metrics,
        elapsedDays: payload.elapsedDays,
        status: payload.status,
      });
      return { result: ok({ ref: ctx.refs.ref("experiment", id), variant: payload.variant, elapsedDays: payload.elapsedDays }), entityId: id };
    },
  },

  refetch_leads: {
    async prepare(params, ctx) {
      if (typeof params.ref === "string") {
        const id = ctx.refs.resolve(params.ref, "lead");
        return {
          summary: fill(t("assistant.action.refetchLead", ctx.lang), { ref: params.ref }),
          payload: { leadId: id },
          entityId: id,
        };
      }
      return { summary: t("assistant.action.refetchLeads", ctx.lang), payload: {} };
    },
    async execute(payload, ctx) {
      const data = await ctx.api("/api/leads/refetch", "POST", payload.leadId ? { leadId: payload.leadId } : {});
      return {
        result: ok(sanitizeRefetchSummary(data)),
        ...(typeof payload.leadId === "string" ? { entityId: payload.leadId } : {}),
      };
    },
  },
};

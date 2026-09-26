import { prisma, type Prisma } from "@admedic/database";
import { getLlmConfig } from "@admedic/config";
import {
  classifyRisk,
  DraftSchema,
  POLICY_RISK_PROMPT_VERSION,
  type Brief,
  type DraftContent,
  type PolicyRiskAssessment,
} from "@admedic/llm";
import type { PolicyResult, PolicyRisk } from "@admedic/policy";
import { z } from "zod";
import { type Actor, EDIT_ROLES, requireRole } from "./auth";
import { checkPolicyWithRules } from "./policy-loader";
import { HttpError } from "./http";
import { withLlmLog } from "./llm-log";

export const SaveSchema = z.object({ content: DraftSchema }).strict();
export const DraftActionSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("edit"),
      version: z.number().int().positive(),
      content: DraftSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("submit"),
      version: z.number().int().positive(),
      /** Orta risk uyarısı okundu; uyarıyla onaya gönderilir (spec 3.5). */
      acknowledgeWarning: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      action: z.enum(["approve", "reject", "experiment"]),
      version: z.number().int().positive(),
    })
    .strict(),
]);
/**
 * Klinik profili üretim bağlamı (spec 3.2): brief'te geçen klinik adıyla eşleşen
 * (veya tek aktif klinikse) profil verisi — marka tonu, diller, hedef pazar,
 * hizmet kataloğu, yasaklı ifadeler — brief'e eklenir. İstemciden gelen `profile`
 * her durumda ATILIR; yalnızca veritabanındaki profil kullanılır.
 */
export async function enrichBriefWithProfile(input: Brief, workspaceId: string): Promise<Brief> {
  const base: Brief = { ...input };
  delete base.profile;
  const clinics = await prisma.clinicProfile.findMany({
    where: { workspaceId, status: "ACTIVE" },
    include: {
      services: { where: { status: "ACTIVE" }, select: { name: true } },
    },
  });
  if (clinics.length === 0) return base;
  const q = base.clinic.trim().toLocaleLowerCase("tr");
  const clinic =
    clinics.find((c) => c.name.toLocaleLowerCase("tr") === q) ??
    (clinics.length === 1 ? clinics[0] : undefined);
  if (!clinic) return base;
  const profile: NonNullable<Brief["profile"]> = {
    ...(clinic.brandTone ? { brandTone: clinic.brandTone } : {}),
    ...(clinic.languages.length > 0 ? { languages: [...clinic.languages] } : {}),
    targetMarket: clinic.targetMarket,
    ...(clinic.services.length > 0 ? { services: clinic.services.map((s) => s.name) } : {}),
    ...(clinic.brandBannedPhrases.length > 0
      ? { bannedPhrases: clinic.brandBannedPhrases }
      : {}),
  };
  return { ...base, profile };
}

/** LLM katmanı sonucu: değerlendirme, hata işareti (`{error:true}`) ya da yapılandırılmamış (`null`). */
export type PolicyLlmLayer = PolicyRiskAssessment | { error: true } | null;
/** Kural katmanı + LLM katmanı birleşik politika sonucu; `risk = max(kural, LLM)`. */
export type StudioPolicy = PolicyResult & {
  /** Yalnızca kural motorunun riski (LLM'siz karar). */
  ruleRisk: PolicyRisk;
  llm: PolicyLlmLayer;
};
export interface PolicyInput {
  variants: ReadonlyArray<{ headline: string; text: string; description?: string; cta: string }>;
  instantForm?: { questions: string[] };
  whatsapp?: { welcome: string };
}

const RISK_ORDER: Record<PolicyRisk, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };
export function maxRisk(a: PolicyRisk, b: PolicyRisk): PolicyRisk {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

/** Kontrol edilen metin tüm üretilen alanları kapsar: varyantlar + Instant Form soruları + WhatsApp karşılaması. */
export function policyText(content: PolicyInput): string {
  return [
    ...content.variants.flatMap((v) => [v.headline, v.text, v.description, v.cta]),
    ...(content.instantForm?.questions ?? []),
    content.whatsapp?.welcome,
  ]
    .filter((s): s is string => Boolean(s))
    .join("\n");
}

/**
 * Politika kontrolü (spec 3.5): katman 1 kural motoru + tenant brand yasaklı
 * ifadeleri, katman 2 LLM. Anahtar yoksa `llm:null`, LLM hatasında `llm:{error:true}`;
 * her iki durumda risk kural sonucudur (yayın engellenmez). LLM varsa risk = max(kural, LLM).
 */
export async function policyFor(
  content: PolicyInput,
  workspaceId: string,
  options: { llm?: boolean } = {},
): Promise<StudioPolicy> {
  const text = policyText(content);
  const clinics = await prisma.clinicProfile.findMany({
    where: { workspaceId, status: "ACTIVE" },
    select: { brandBannedPhrases: true },
  });
  const rules = await checkPolicyWithRules(
    text,
    clinics.flatMap((c) => c.brandBannedPhrases),
  );
  const llm = options.llm === false ? null : await llmRisk(text, workspaceId);
  const risk = llm && !("error" in llm) ? maxRisk(rules.risk, llm.risk) : rules.risk;
  return { ...rules, risk, ruleRisk: rules.risk, llm };
}
async function llmRisk(text: string, workspaceId: string): Promise<PolicyLlmLayer> {
  const config = getLlmConfig();
  if (!config) return null;
  try {
    const { risk, reason, correctedCopy } = await withLlmLog({
      workspaceId,
      agent: "policy-checker",
      promptVersion: POLICY_RISK_PROMPT_VERSION,
      model: config.model,
      run: () => classifyRisk(text, config),
    });
    return { risk, reason, ...(correctedCopy ? { correctedCopy } : {}) };
  } catch {
    return { error: true };
  }
}
/** Kaydedilmiş politika JSON'undan sürüm/risk okur (eski kayıt biçimlerine toleranslı). */
function storedPolicy(value: Prisma.JsonValue): { version: string | null; risk: PolicyRisk | null } {
  const record = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const risk = record.risk;
  return {
    version: typeof record.version === "string" ? record.version : null,
    risk: risk === "LOW" || risk === "MEDIUM" || risk === "HIGH" ? risk : null,
  };
}

/** Orta risk: onaya gönderim `acknowledgeWarning:true` olmadan 422 + `policyWarning` (spec 3.5). */
export class PolicyWarningError extends HttpError {
  constructor(public readonly policyWarning: StudioPolicy) {
    super(
      422,
      "İçerik kontrolü orta risk buldu. Uyarıyı inceleyip onaylayarak yine de onaya gönderebilirsiniz.",
    );
  }
}
function audit(
  tx: Prisma.TransactionClient,
  actor: Actor,
  action: string,
  id: string,
  before: Prisma.InputJsonValue,
  after: Prisma.InputJsonValue,
  entityType = "STUDIO_DRAFT",
) {
  return tx.auditLog.create({
    data: {
      orgId: actor.orgId,
      workspaceId: actor.workspaceId,
      userId: actor.userId,
      action,
      entityType,
      entityId: id,
      before,
      after,
    },
  });
}
export async function createDraft(actor: Actor, content: DraftContent) {
  requireRole(actor, EDIT_ROLES);
  const policy = await policyFor(content, actor.workspaceId);
  return prisma.$transaction(async (tx) => {
    const draft = await tx.studioDraft.create({
      data: {
        workspaceId: actor.workspaceId,
        name: `${content.clinic} · ${content.service}`,
        content,
        policy: policy as unknown as Prisma.InputJsonValue,
      },
    });
    await audit(
      tx,
      actor,
      "DRAFT_CREATED",
      draft.id,
      {},
      { version: draft.version, status: draft.status, risk: policy.risk },
    );
    return draft;
  });
}
export async function getDraft(actor: Actor, id: string) {
  const draft = await prisma.studioDraft.findFirst({
    where: { id, workspaceId: actor.workspaceId },
    include: { experiment: true },
  });
  if (!draft) throw new HttpError(404, "Taslak bulunamadı.");
  return draft;
}
/**
 * Taslak geçişleri. Politika (LLM dahil) transaction DIŞINDA hesaplanır; kısa transaction
 * yalnızca sürüm korumalı yazım + audit içerir. Reject'te LLM çağrısı yapılmaz (kayıtlı politika korunur).
 */
export async function changeDraft(
  actor: Actor,
  id: string,
  input: z.infer<typeof DraftActionSchema>,
) {
  requireRole(
    actor,
    input.action === "approve" || input.action === "reject"
      ? ["OWNER", "ADMIN"]
      : EDIT_ROLES,
  );
  const draft = await prisma.studioDraft.findFirst({
    where: { id, workspaceId: actor.workspaceId },
  });
  if (!draft) throw new HttpError(404, "Taslak bulunamadı.");
  if (draft.version !== input.version)
    throw new HttpError(
      409,
      "Taslak değişmiş. Sayfayı yenileyip tekrar deneyin.",
    );
  const content =
    input.action === "edit"
      ? input.content
      : DraftSchema.parse(draft.content);
  let status = draft.status;
  if (input.action === "edit") status = "DRAFT";
  else if (input.action === "submit") {
    if (!["DRAFT", "REJECTED"].includes(status))
      throw new HttpError(409, "Bu taslak zaten incelemede veya onaylı.");
    status = "IN_REVIEW";
  } else if (input.action === "approve" || input.action === "reject") {
    if (status !== "IN_REVIEW")
      throw new HttpError(
        409,
        "Yalnızca incelemedeki taslak için karar verilebilir.",
      );
    status = input.action === "approve" ? "APPROVED" : "REJECTED";
  } else if (status !== "APPROVED")
    throw new HttpError(409, "Deney oluşturmadan önce taslak onaylanmalı.");

  const recompute = input.action !== "reject";
  const policy = recompute ? await policyFor(content, actor.workspaceId) : null;
  const policyMeta = policy ?? storedPolicy(draft.policy);
  if (
    policy &&
    ["submit", "approve", "experiment"].includes(input.action) &&
    policy.risk === "HIGH"
  )
    throw new HttpError(
      422,
      "Önce içerik kontrolündeki yüksek riskli ifadeleri düzeltin.",
    );
  const warningAcknowledged =
    input.action === "submit" && policy?.risk === "MEDIUM";
  if (warningAcknowledged && policy && !input.acknowledgeWarning)
    throw new PolicyWarningError(policy);
  if (input.action === "experiment") {
    const [a, b] = content.variants;
    if (a.headline === b.headline || a.text !== b.text || a.cta !== b.cta)
      throw new HttpError(
        422,
        "Başlık testinde başlıklar farklı, metin ve CTA aynı olmalı.",
      );
  }
  const before = {
    status: draft.status,
    version: draft.version,
    ...(input.action === "edit" ? { content: draft.content } : {}),
  };
  return prisma.$transaction(async (tx) => {
    const updated = await tx.studioDraft.updateMany({
      where: { id, workspaceId: actor.workspaceId, version: input.version },
      data: {
        content,
        policy: (policy ?? draft.policy) as Prisma.InputJsonValue,
        status,
        name: `${content.clinic} · ${content.service}`,
        version: { increment: 1 },
      },
    });
    if (!updated.count)
      throw new HttpError(
        409,
        "Eşzamanlı değişiklik algılandı. Sayfayı yenileyin.",
      );
    if (input.action === "experiment") {
      const existing = await tx.studioExperiment.findUnique({
        where: { draftId: id },
      });
      if (existing)
        throw new HttpError(
          409,
          "Bu taslağın zaten bir deneyi var. Yeni test için yeni taslak oluşturun.",
        );
      const experiment = await tx.studioExperiment.create({
        data: {
          draftId: id,
          snapshot: content,
          metrics: [
            { spend: 0, clicks: 0, leads: 0 },
            { spend: 0, clicks: 0, leads: 0 },
          ],
        },
      });
      await audit(
        tx,
        actor,
        "EXPERIMENT_CREATED",
        experiment.id,
        {},
        { draftId: id, draftVersion: input.version, status: "DRAFT" },
        "STUDIO_EXPERIMENT",
      );
      await audit(tx, actor, "DRAFT_EXPERIMENT_LINKED", id, before, {
        status,
        version: input.version + 1,
      });
      return { experimentId: experiment.id };
    }
    await audit(tx, actor, `DRAFT_${input.action.toUpperCase()}`, id, before, {
      status,
      version: input.version + 1,
      policyVersion: policyMeta.version,
      risk: policyMeta.risk,
      ...(input.action === "edit" ? { content } : {}),
      ...(warningAcknowledged ? { policyWarningAcknowledged: true } : {}),
    });
    return { id };
  });
}

const MetricSchema = z
  .object({
    spend: z.number().finite().nonnegative().max(1_000_000),
    clicks: z.number().int().nonnegative().max(1_000_000_000),
    leads: z.number().int().nonnegative().max(1_000_000_000),
  })
  .strict()
  .refine((m) => m.leads <= m.clicks);
export const ExperimentUpdateSchema = z
  .object({
    version: z.number().int().positive(),
    metrics: z.tuple([MetricSchema, MetricSchema]),
    elapsedDays: z.number().int().min(0).max(365),
    status: z.enum(["DRAFT", "RUNNING", "COMPLETED"]),
  })
  .strict();
export async function getExperiment(actor: Actor, id: string) {
  const experiment = await prisma.studioExperiment.findFirst({
    where: { id, draft: { workspaceId: actor.workspaceId } },
  });
  if (!experiment) throw new HttpError(404, "Deney bulunamadı.");
  return experiment;
}
export async function updateExperiment(
  actor: Actor,
  id: string,
  input: z.infer<typeof ExperimentUpdateSchema>,
) {
  requireRole(actor, EDIT_ROLES);
  return prisma.$transaction(async (tx) => {
    const exp = await tx.studioExperiment.findFirst({
      where: { id, draft: { workspaceId: actor.workspaceId } },
    });
    if (!exp) throw new HttpError(404, "Deney bulunamadı.");
    if (exp.status === "COMPLETED")
      throw new HttpError(409, "Tamamlanan deney değiştirilemez.");
    if (exp.status === "RUNNING" && input.status === "DRAFT")
      throw new HttpError(409, "Başlatılan deney taslağa döndürülemez.");
    if (input.elapsedDays < exp.elapsedDays)
      throw new HttpError(422, "Geçen gün sayısı azaltılamaz.");
    const content = DraftSchema.parse(exp.snapshot);
    if (
      input.status === "COMPLETED" &&
      (exp.status !== "RUNNING" || input.elapsedDays < content.duration)
    )
      throw new HttpError(
        422,
        "Testi başlatın ve planlanan süreyi tamamlayın.",
      );
    const result = await tx.studioExperiment.updateMany({
      where: {
        id,
        version: input.version,
        draft: { workspaceId: actor.workspaceId },
      },
      data: {
        metrics: input.metrics,
        elapsedDays: input.elapsedDays,
        status: input.status,
        version: { increment: 1 },
      },
    });
    if (!result.count)
      throw new HttpError(409, "Deney değişmiş. Sayfayı yenileyin.");
    await audit(
      tx,
      actor,
      "EXPERIMENT_UPDATED",
      id,
      {
        version: exp.version,
        status: exp.status,
        metrics: exp.metrics ?? [],
        elapsedDays: exp.elapsedDays,
      },
      {
        version: exp.version + 1,
        status: input.status,
        metrics: input.metrics,
        elapsedDays: input.elapsedDays,
      },
      "STUDIO_EXPERIMENT",
    );
    return { id };
  });
}

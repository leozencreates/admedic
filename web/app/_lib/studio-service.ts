import { prisma, type Prisma } from "@admedic/database";
import { loadEnv } from "@admedic/config";
import { classifyRisk, DraftSchema, type DraftContent } from "@admedic/llm";
import { z } from "zod";
import { type Actor, EDIT_ROLES, requireRole } from "./auth";
import { checkPolicyWithRules } from "./policy-loader";
import { HttpError } from "./http";

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
      action: z.enum(["submit", "approve", "reject", "experiment"]),
      version: z.number().int().positive(),
    })
    .strict(),
]);
/**
 * Politika kontrolü (spec 3.5): katman 1 kural motoru + tenant brand yasaklı
 * ifadeleri, katman 2 LLM best-effort (anahtar yoksa/hata olursa llm:null).
 */
export async function policyFor(content: DraftContent, workspaceId: string) {
  const text = content.variants
    .map((v) => [v.headline, v.text, v.cta, v.description])
    .flat()
    .filter(Boolean)
    .join("\n");
  const clinics = await prisma.clinicProfile.findMany({
    where: { workspaceId, status: "ACTIVE" },
    select: { brandBannedPhrases: true },
  });
  const policy = await checkPolicyWithRules(
    text,
    clinics.flatMap((c) => c.brandBannedPhrases),
  );
  const llm = await llmRisk(text);
  return llm ? { ...policy, llm } : policy;
}
async function llmRisk(text: string) {
  loadEnv();
  const key = process.env.ANTHROPIC_API_KEY;
  const model = process.env.LLM_MODEL;
  if (!key || !model) return null;
  try {
    return await classifyRisk(text, key, model);
  } catch {
    return null;
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
        policy,
      },
    });
    await audit(
      tx,
      actor,
      "DRAFT_CREATED",
      draft.id,
      {},
      { version: draft.version, status: draft.status },
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
  return prisma.$transaction(async (tx) => {
    const draft = await tx.studioDraft.findFirst({
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
    const policy = await policyFor(content, actor.workspaceId);
    const before = {
      status: draft.status,
      version: draft.version,
      ...(input.action === "edit" ? { content: draft.content } : {}),
    };
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
    if (
      ["submit", "approve", "experiment"].includes(input.action) &&
      policy.risk === "HIGH"
    )
      throw new HttpError(
        422,
        "Önce içerik kontrolündeki yüksek riskli ifadeleri düzeltin.",
      );
    if (input.action === "experiment") {
      const [a, b] = content.variants;
      if (a.headline === b.headline || a.text !== b.text || a.cta !== b.cta)
        throw new HttpError(
          422,
          "Başlık testinde başlıklar farklı, metin ve CTA aynı olmalı.",
        );
    }
    const updated = await tx.studioDraft.updateMany({
      where: { id, workspaceId: actor.workspaceId, version: input.version },
      data: {
        content,
        policy,
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
      policyVersion: policy.version,
      risk: policy.risk,
      ...(input.action === "edit" ? { content } : {}),
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

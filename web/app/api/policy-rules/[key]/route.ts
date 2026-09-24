import { prisma, type PolicyMatcher } from "@admedic/database";
import { z } from "zod";
import { body, respond, sameOrigin, HttpError } from "../../../_lib/http";
import { requirePlatformAdmin } from "../../../_lib/auth";
import { logAudit } from "../../../_lib/audit";
import { invalidatePolicyRuleCache } from "../../../_lib/policy-loader";

export const maxDuration = 15;

const UpdateRuleSchema = z
  .object({
    expectedPreviousVersion: z.number().int().positive(),
    intendedVersion: z.number().int().positive(),
    active: z.boolean().optional(),
    matcher: z.enum(["GUARANTEE_V1", "BEFORE_AFTER_V1", "PERSONAL_ATTRIBUTE_V1", "PHRASES_V1"]).optional(),
    phrases: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
    risk: z.enum(["LOW", "MEDIUM", "HIGH"]).optional(),
    reason: z.string().trim().min(1).max(500).optional(),
    suggestion: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export async function GET(_request: Request, { params }: { params: Promise<{ key: string }> }) {
  return respond(async () => {
    await requirePlatformAdmin();
    const { key } = await params;
    const rules = await prisma.policyRule.findMany({
      where: { key },
      orderBy: { version: "desc" },
    });
    if (!rules.length) throw new HttpError(404, "Kural bulunamadı.");
    return { key, rules };
  });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ key: string }> }) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requirePlatformAdmin();
    const { key } = await params;
    const input = await body(request, UpdateRuleSchema);
    const existing = await prisma.policyRule.findFirst({
      where: { key },
      orderBy: { version: "desc" },
      select: { version: true },
    });
    if (!existing) throw new HttpError(404, "Kural bulunamadı.");
    if (existing.version !== input.expectedPreviousVersion)
      throw new HttpError(409, "Kural sürümü değişti. Güncel sürümü yeniden yükleyin.");
    const target = await prisma.policyRule.findFirst({
      where: { key, version: input.intendedVersion },
      select: { id: true, version: true, matcher: true, phrases: true, risk: true, reason: true, suggestion: true, active: true },
    });
    if (!target) throw new HttpError(422, "Güncellenecek sürüm bulunamadı.");
    const created = await prisma.$transaction(async (tx) => {
      const rule = await tx.policyRule.create({
        data: {
          key,
          version: target.version + 1,
          matcher: (input.matcher ?? target.matcher) as PolicyMatcher,
          phrases: input.phrases ?? target.phrases,
          risk: input.risk ?? target.risk,
          reason: input.reason ?? target.reason,
          suggestion: input.suggestion ?? target.suggestion,
          active: input.active ?? true,
          createdBy: actor.userId,
        },
      });
      await logAudit(
        {
          actor,
          action: "POLICY_RULE_UPDATED",
          entityType: "PolicyRule",
          entityId: rule.id,
          before: { key, version: target.version, active: target.active },
          after: { key, version: rule.version, active: rule.active, matcher: rule.matcher },
        },
        tx,
      );
      return rule;
    });
    invalidatePolicyRuleCache();
    return {
      rule: {
        id: created.id, key: created.key, version: created.version,
        matcher: created.matcher, phrases: created.phrases, risk: created.risk,
        reason: created.reason, suggestion: created.suggestion, active: created.active,
      },
    };
  });
}
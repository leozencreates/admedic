import { prisma, type PolicyMatcher } from "@admedic/database";
import { z } from "zod";
import { body, respond, sameOrigin, HttpError } from "../../_lib/http";
import { requirePlatformAdmin } from "../../_lib/auth";
import { logAudit } from "../../_lib/audit";
import { invalidatePolicyRuleCache } from "../../_lib/policy-loader";

export const maxDuration = 15;

const PolicyRuleSchema = z
  .object({
    key: z.string().trim().min(1).max(50),
    matcher: z.enum(["GUARANTEE_V1", "BEFORE_AFTER_V1", "PERSONAL_ATTRIBUTE_V1", "PHRASES_V1"]),
    phrases: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
    risk: z.enum(["LOW", "MEDIUM", "HIGH"]),
    reason: z.string().trim().min(1).max(500),
    suggestion: z.string().trim().min(1).max(500),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.matcher === "PHRASES_V1" && v.phrases.length === 0)
      ctx.addIssue({ code: "custom", path: ["phrases"], message: "Phrases kuralı en az bir ifade içermeli." });
  });

export async function GET() {
  return respond(async () => {
    const actor = await requirePlatformAdmin();
    const rows = await prisma.policyRule.groupBy({
      by: ["key"],
      _max: { version: true },
    });
    const keys = rows.map((r) => r.key);
    const rules = await prisma.policyRule.findMany({
      where: { key: { in: keys } },
      orderBy: { createdAt: "asc" },
    });
    const latest = new Map<string, (typeof rules)[number]>();
    for (const rule of rules) {
      const prev = latest.get(rule.key);
      if (!prev || rule.version > prev.version) latest.set(rule.key, rule);
    }
    return {
      actor: { userId: actor.userId, workspaceName: actor.workspaceName },
      rules: [...latest.values()].map((r) => ({
        id: r.id,
        key: r.key,
        version: r.version,
        matcher: r.matcher,
        phrases: r.phrases,
        risk: r.risk,
        reason: r.reason,
        suggestion: r.suggestion,
        active: r.active,
        createdAt: r.createdAt,
        createdBy: r.createdBy,
      })),
    };
  });
}

export async function POST(request: Request) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requirePlatformAdmin();
    const input = await body(request, PolicyRuleSchema);
    let version = 1;
    const existing = await prisma.policyRule.findFirst({
      where: { key: input.key },
      orderBy: { version: "desc" },
      select: { version: true },
    });
    if (existing) {
      const current = await prisma.policyRule.findFirst({
        where: { key: input.key, version: existing.version },
        select: { active: true },
      });
      if (current?.active)
        throw new HttpError(409, "Bu kural zaten aktif. Düzenlemek için önceki sürümü kullanın.");
      version = existing.version + 1;
    }
    const created = await prisma.$transaction(async (tx) => {
      const rule = await tx.policyRule.create({
        data: {
          key: input.key,
          version,
          matcher: input.matcher as PolicyMatcher,
          phrases: input.phrases,
          risk: input.risk,
          reason: input.reason,
          suggestion: input.suggestion,
          active: true,
          createdBy: actor.userId,
        },
      });
      await logAudit(
        {
          actor,
          action: "POLICY_RULE_CREATED",
          entityType: "PolicyRule",
          entityId: rule.id,
          before: {},
          after: { key: rule.key, version: rule.version, matcher: rule.matcher, active: rule.active },
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
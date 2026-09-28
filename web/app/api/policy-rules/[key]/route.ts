import { prisma, type PolicyMatcher } from "@admedic/database";
import { z } from "zod";
import { body, respond, sameOrigin, HttpError } from "../../../_lib/http";
import { requireActor, requirePlatformAdmin } from "../../../_lib/auth";
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

/** Sürüm geçmişi; oturum açmış herkes okuyabilir (salt okunur şeffaflık). */
export async function GET(_request: Request, { params }: { params: Promise<{ key: string }> }) {
  return respond(async () => {
    await requireActor();
    const { key } = await params;
    const rules = await prisma.policyRule.findMany({
      where: { key },
      orderBy: { version: "desc" },
    });
    if (!rules.length) throw new HttpError(404, "Kural bulunamadı; silinmiş olabilir. İçerik kuralları sayfasını yenileyin.");
    return { key, rules };
  });
}

/**
 * Yeni sürüm (append-only, ADR-0008). `expectedPreviousVersion` VE `intendedVersion`
 * en güncel sürüm olmalıdır (eski sürümden dallanma yok → 409). Gönderilmeyen
 * alanlar (aktiflik dahil) mevcut sürümden korunur; PHRASES_V1 boş liste kabul edilmez.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ key: string }> }) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requirePlatformAdmin();
    const { key } = await params;
    const input = await body(request, UpdateRuleSchema);
    const target = await prisma.policyRule.findFirst({
      where: { key },
      orderBy: { version: "desc" },
      select: { id: true, version: true, matcher: true, phrases: true, risk: true, reason: true, suggestion: true, active: true },
    });
    if (!target) throw new HttpError(404, "Kural bulunamadı; silinmiş olabilir. İçerik kuralları sayfasını yenileyin.");
    if (target.version !== input.expectedPreviousVersion)
      throw new HttpError(409, "Kural sürümü değişti. Güncel sürümü yeniden yükleyin.");
    if (input.intendedVersion !== target.version)
      throw new HttpError(
        409,
        `Yalnızca en güncel sürüm (v${target.version}) düzenlenebilir; eski sürümden yeni dal açılamaz.`,
      );
    const next = {
      matcher: (input.matcher ?? target.matcher) as PolicyMatcher,
      phrases: input.phrases ?? target.phrases,
      risk: input.risk ?? target.risk,
      reason: input.reason ?? target.reason,
      suggestion: input.suggestion ?? target.suggestion,
      // Aktiflik yalnızca açıkça gönderilirse değişir (önceki hata: varsayılan `true`).
      active: input.active ?? target.active,
    };
    if (next.matcher === "PHRASES_V1" && next.phrases.length === 0)
      throw new HttpError(400, "İfade listesi kuralı en az bir ifade içermeli. İfadeler alanına virgülle ayırarak en az bir ifade girin.");
    const changed = (Object.keys(next) as Array<keyof typeof next>).filter((field) => {
      const a = next[field];
      const b = target[field];
      if (Array.isArray(a) && Array.isArray(b)) return a.length !== b.length || a.some((v, i) => v !== b[i]);
      return a !== b;
    });
    if (changed.length === 0)
      throw new HttpError(400, "Değişiklik yok; yeni sürüm oluşturulmadı.");
    const before: Record<string, unknown> = { key, version: target.version };
    const after: Record<string, unknown> = { key, version: target.version + 1 };
    for (const field of changed) {
      before[field] = target[field];
      after[field] = next[field];
    }
    const created = await prisma.$transaction(async (tx) => {
      const rule = await tx.policyRule.create({
        data: {
          key,
          version: target.version + 1,
          ...next,
          createdBy: actor.userId,
        },
      });
      await logAudit(
        {
          actor,
          action: "POLICY_RULE_UPDATED",
          entityType: "PolicyRule",
          entityId: rule.id,
          before: before as Parameters<typeof logAudit>[0]["before"],
          after: after as Parameters<typeof logAudit>[0]["after"],
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
      changed,
    };
  });
}

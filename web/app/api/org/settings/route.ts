import { prisma } from "@admedic/database";
import { requireActor, requireRole } from "../../../_lib/auth";
import { body, respond, sameOrigin } from "../../../_lib/http";
import { z } from "zod";
import { logAudit } from "../../../_lib/audit";
export const maxDuration = 10;
/**
 * Kuruluş ayarları. `monthlyAdBudgetCap` major (insan) birim girilir, cent saklanır
 * (ADR-0011); `null` üst sınırı kaldırır. Yanıtta cent değeri `monthlyAdBudgetCapCents`,
 * major değeri `monthlyAdBudgetCap` olarak döner.
 */
const OrgSettingsSchema = z
  .object({
    monthlyAdBudgetCap: z.number().positive().max(100_000_000).nullable().optional(),
    reportRecipient: z.string().trim().email().max(254).nullable().optional(),
    retentionDays: z.number().int().min(30).max(3650).optional(),
    consentText: z.string().max(4000).optional().nullable(),
  })
  .strict();
const SELECT = {
  monthlyAdBudgetCap: true,
  reportRecipient: true,
  retentionDays: true,
  consentText: true,
} as const;
type OrgRow = {
  monthlyAdBudgetCap: number | null;
  reportRecipient: string | null;
  retentionDays: number;
  consentText: string | null;
};
function present(org: OrgRow, currency: string) {
  return {
    monthlyAdBudgetCapCents: org.monthlyAdBudgetCap,
    monthlyAdBudgetCap: org.monthlyAdBudgetCap == null ? null : org.monthlyAdBudgetCap / 100,
    currency,
    reportRecipient: org.reportRecipient,
    retentionDays: org.retentionDays,
    consentText: org.consentText,
  };
}
async function accountCurrency(orgId: string, workspaceId: string) {
  const account = await prisma.adAccount.findFirst({
    where: { orgId, workspaceId, status: "ACTIVE" },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    select: { currency: true },
  });
  return account?.currency ?? "EUR";
}
export async function GET() {
  return respond(async () => {
    const actor = await requireActor();
    const [org, currency] = await Promise.all([
      prisma.organization.findUniqueOrThrow({ where: { id: actor.orgId }, select: SELECT }),
      accountCurrency(actor.orgId, actor.workspaceId),
    ]);
    return { settings: present(org, currency) };
  });
}
export async function PATCH(request: Request) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, ["OWNER", "ADMIN"]);
    const input = await body(request, OrgSettingsSchema);
    const currency = await accountCurrency(actor.orgId, actor.workspaceId);
    const org = await prisma.$transaction(async (tx) => {
      const before = await tx.organization.findUniqueOrThrow({
        where: { id: actor.orgId },
        select: SELECT,
      });
      const after = await tx.organization.update({
        where: { id: actor.orgId },
        data: {
          ...(input.monthlyAdBudgetCap !== undefined
            ? {
                monthlyAdBudgetCap:
                  input.monthlyAdBudgetCap == null ? null : Math.round(input.monthlyAdBudgetCap * 100),
              }
            : {}),
          ...(input.reportRecipient !== undefined
            ? { reportRecipient: input.reportRecipient }
            : {}),
          ...(input.retentionDays !== undefined
            ? { retentionDays: input.retentionDays }
            : {}),
          ...(input.consentText !== undefined
            ? { consentText: input.consentText }
            : {}),
        },
        select: SELECT,
      });
      await logAudit({
        actor,
        action: "ORG_SETTINGS_UPDATED",
        entityType: "ORGANIZATION",
        entityId: actor.orgId,
        before: {
          monthlyAdBudgetCapCents: before.monthlyAdBudgetCap,
          reportRecipient: before.reportRecipient,
          retentionDays: before.retentionDays,
          consentText: before.consentText,
        },
        after: {
          monthlyAdBudgetCapCents: after.monthlyAdBudgetCap,
          reportRecipient: after.reportRecipient,
          retentionDays: after.retentionDays,
          consentText: after.consentText,
        },
      }, tx);
      return after;
    });
    return { settings: present(org, currency) };
  });
}

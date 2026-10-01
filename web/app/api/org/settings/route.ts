import { prisma } from "@admedic/database";
import { requireActor, requireRole } from "../../../_lib/auth";
import { body, HttpError, respond, sameOrigin } from "../../../_lib/http";
import { z } from "zod";
import { logAudit } from "../../../_lib/audit";
import { activeMonthlyCommitmentCents } from "../../../_lib/spend-cap";
export const maxDuration = 10;
/**
 * Kuruluş ayarları. `monthlyAdBudgetCap` major (insan) birim girilir, cent saklanır
 * (ADR-0011); `null` üst sınırı kaldırır. Yanıtta cent değeri `monthlyAdBudgetCapCents`,
 * major değeri `monthlyAdBudgetCap` olarak döner. Üst sınırı yükseltmek veya kaldırmak yalnızca
 * Owner'a aittir (sınır, harcama yetkisi devredilen üyeleri de bağlayan korumadır); düşürmek
 * OWNER/ADMIN için serbesttir.
 */
const OrgSettingsSchema = z
  .object({
    monthlyAdBudgetCap: z.number().positive().max(100_000_000).nullable().optional(),
    reportRecipient: z.string().trim().email().max(254).nullable().optional(),
    retentionDays: z.number().int().min(30).max(3650).optional(),
    /** Açık rıza metni (rıza beyanı). Aydınlatma içeriği `privacyNoticeText`'e yazılır (KVKK İlke Kararı 2026/347). */
    consentText: z.string().max(4000).optional().nullable(),
    /** KVKK aydınlatma metni (md. 10); yalnızca bilgilendirir, onay istenmez. */
    privacyNoticeText: z.string().max(20000).optional().nullable(),
    /** Instant Form (Meta lead formu) gizlilik politikası bağlantısı; yalnızca https. */
    privacyPolicyUrl: z
      .string()
      .trim()
      .max(2048)
      .url()
      .refine((v) => v.toLowerCase().startsWith("https://"), "Gizlilik politikası bağlantısı https:// ile başlamalıdır.")
      .nullable()
      .optional(),
    /** Sesli ajan müsait lead'leri kendiliğinden arar (ADR-0026). Açmak yalnızca hesap sahibine aittir. */
    voiceAutoCallEnabled: z.boolean().optional(),
    /** Randevuya dönüşen Instagram konuşmalarındaki ekip yanıtları asistana örnek olur (ADR-0027). */
    assistantExamplesEnabled: z.boolean().optional(),
  })
  .strict();
const SELECT = {
  monthlyAdBudgetCap: true,
  reportRecipient: true,
  retentionDays: true,
  consentText: true,
  privacyNoticeText: true,
  privacyPolicyUrl: true,
  voiceAutoCallEnabled: true,
  assistantExamplesEnabled: true,
} as const;
type OrgRow = {
  monthlyAdBudgetCap: number | null;
  reportRecipient: string | null;
  retentionDays: number;
  consentText: string | null;
  privacyNoticeText: string | null;
  privacyPolicyUrl: string | null;
  voiceAutoCallEnabled: boolean;
  assistantExamplesEnabled: boolean;
};
function present(org: OrgRow, currency: string, monthlyCommittedCents: number) {
  return {
    monthlyAdBudgetCapCents: org.monthlyAdBudgetCap,
    monthlyAdBudgetCap: org.monthlyAdBudgetCap == null ? null : org.monthlyAdBudgetCap / 100,
    /** Aktif kampanyaların aylık toplamı (aynı para birimindeki hesaplar; minor unit). */
    monthlyCommittedCents,
    currency,
    reportRecipient: org.reportRecipient,
    retentionDays: org.retentionDays,
    consentText: org.consentText,
    privacyNoticeText: org.privacyNoticeText,
    privacyPolicyUrl: org.privacyPolicyUrl,
    voiceAutoCallEnabled: org.voiceAutoCallEnabled,
    assistantExamplesEnabled: org.assistantExamplesEnabled,
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
    const committed = await activeMonthlyCommitmentCents(prisma, actor.orgId, currency);
    const settings = present(org, currency, committed);
    // Rapor alıcısının e-postası yalnızca ayarı değiştirebilen rollere döner.
    if (actor.role !== "OWNER" && actor.role !== "ADMIN") return { settings: { ...settings, reportRecipient: null } };
    return { settings };
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
      // Eşzamanlı sınır değişikliklerini sıraya sok (yükseltme kararı güncel değere göre verilir).
      await tx.$queryRaw`SELECT "id" FROM "Organization" WHERE "id" = ${actor.orgId} FOR UPDATE`;
      const before = await tx.organization.findUniqueOrThrow({
        where: { id: actor.orgId },
        select: SELECT,
      });
      const nextCapCents =
        input.monthlyAdBudgetCap === undefined
          ? undefined
          : input.monthlyAdBudgetCap == null
            ? null
            : Math.round(input.monthlyAdBudgetCap * 100);
      if (nextCapCents !== undefined) {
        const loosens =
          before.monthlyAdBudgetCap != null && (nextCapCents == null || nextCapCents > before.monthlyAdBudgetCap);
        if (loosens && actor.role !== "OWNER")
          throw new HttpError(
            403,
            "Aylık üst sınırı yükseltmek veya kaldırmak yalnızca hesap sahibi tarafından yapılabilir. Hesap sahibinden bu değişikliği yapmasını isteyin.",
          );
      }
      // Otomatik arama hastayla insan kararı olmadan temas kurar; açma kararı hesap sahibinindir.
      if (input.voiceAutoCallEnabled === true && !before.voiceAutoCallEnabled && actor.role !== "OWNER")
        throw new HttpError(403, "Otomatik aramayı yalnızca hesap sahibi açabilir.");
      const after = await tx.organization.update({
        where: { id: actor.orgId },
        data: {
          ...(nextCapCents !== undefined ? { monthlyAdBudgetCap: nextCapCents } : {}),
          ...(input.reportRecipient !== undefined
            ? { reportRecipient: input.reportRecipient }
            : {}),
          ...(input.retentionDays !== undefined
            ? { retentionDays: input.retentionDays }
            : {}),
          ...(input.consentText !== undefined
            ? { consentText: input.consentText }
            : {}),
          ...(input.privacyNoticeText !== undefined
            ? { privacyNoticeText: input.privacyNoticeText }
            : {}),
          ...(input.privacyPolicyUrl !== undefined
            ? { privacyPolicyUrl: input.privacyPolicyUrl }
            : {}),
          ...(input.voiceAutoCallEnabled !== undefined ? { voiceAutoCallEnabled: input.voiceAutoCallEnabled } : {}),
          ...(input.assistantExamplesEnabled !== undefined
            ? { assistantExamplesEnabled: input.assistantExamplesEnabled }
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
          privacyNoticeText: before.privacyNoticeText,
          privacyPolicyUrl: before.privacyPolicyUrl,
          voiceAutoCallEnabled: before.voiceAutoCallEnabled,
          assistantExamplesEnabled: before.assistantExamplesEnabled,
        },
        after: {
          monthlyAdBudgetCapCents: after.monthlyAdBudgetCap,
          reportRecipient: after.reportRecipient,
          retentionDays: after.retentionDays,
          consentText: after.consentText,
          privacyNoticeText: after.privacyNoticeText,
          privacyPolicyUrl: after.privacyPolicyUrl,
          voiceAutoCallEnabled: after.voiceAutoCallEnabled,
          assistantExamplesEnabled: after.assistantExamplesEnabled,
        },
      }, tx);
      return after;
    });
    const committed = await activeMonthlyCommitmentCents(prisma, actor.orgId, currency);
    return { settings: present(org, currency, committed) };
  });
}

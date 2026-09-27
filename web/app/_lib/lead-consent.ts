import type { Prisma } from "@admedic/database";
import type { LeadDisclaimerResponse } from "@admedic/meta-api";

/**
 * Instant Form rızası (spec 3.11, ADR-0015): Admedic'in kurduğu lead formlarında zorunlu bir rıza kutusu
 * vardır (`LEAD_FORM_CONSENT_KEY`). Gelen lead'in kutu yanıtı, formda gösterilen metnin yayın anındaki
 * kopyasıyla (`LeadForm.consentText`) `ConsentRecord`'a yazılır.
 *
 * - Tür `DATA_PROCESSING`: kutu metni "talebe yanıt ve iletişim için veri işleme" onayıdır; pazarlama/ölçüm
 *   (CAPI) rızası DEĞİLDİR, bu yüzden `Lead.consentGiven` değişmez.
 * - Dayanak: Meta `custom_disclaimer_responses` yanıtı (`CHECKBOX_RESPONSE`); yanıt gelmezse (webhook içi
 *   veri, alanları çekilemeyen lead) zorunlu kutu, formun gönderilebilmesinin ön koşulu olduğundan
 *   (`REQUIRED_CHECKBOX`) rıza verilmiş sayılır. Kutu açıkça işaretsiz gelirse DENIED yazılır.
 * - Admedic'in kurmadığı (Ads Manager) formlarda metin bilinmediği için kayıt yazılmaz; ham yanıtlar lead
 *   metadata'sında kalır.
 * - Lead başına bir Instant Form kaydı: yeniden çekimde ikinci kayıt yazılmaz, geri çekilmiş rıza yeniden verilmez.
 */

export const INSTANT_FORM_CONSENT_SOURCE = "INSTANT_FORM";

export type FormConsentBasis = "CHECKBOX_RESPONSE" | "REQUIRED_CHECKBOX";

export interface InstantFormConsentInput {
  orgId: string;
  workspaceId: string;
  leadId: string;
  leadgenId: string;
  formId: string | null;
  /** `null`: kaynak kutu yanıtlarını taşımıyor. */
  responses: LeadDisclaimerResponse[] | null;
  /** Meta `created_time` (ISO ya da Unix saniye); yoksa kayıt anı. */
  submittedAt: string | null;
}

export interface InstantFormConsentOutcome {
  status: "GRANTED" | "DENIED" | "WITHDRAWN" | "NONE";
  reason: "RECORDED" | "ALREADY_RECORDED" | "NO_FORM" | "UNKNOWN_FORM" | "NO_RESPONSE";
  basis?: FormConsentBasis;
}

/** Meta zaman damgası: ISO ("2026-09-26T08:00:00+0000") veya Unix saniye ("1758870000"). */
export function parseMetaTime(value: string | null | undefined): Date | null {
  const raw = (value ?? "").trim();
  if (!raw) return null;
  const date = /^\d{9,11}$/.test(raw) ? new Date(Number(raw) * 1000) : new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function recordInstantFormConsent(
  tx: Prisma.TransactionClient,
  input: InstantFormConsentInput,
): Promise<InstantFormConsentOutcome> {
  if (!input.formId) return { status: "NONE", reason: "NO_FORM" };
  const form = await tx.leadForm.findUnique({ where: { metaFormId: input.formId } });
  // Başka kuruluşun formu (kimlik çakışması) hiçbir zaman eşlenmez.
  if (!form || form.orgId !== input.orgId) return { status: "NONE", reason: "UNKNOWN_FORM" };
  const existing = await tx.consentRecord.findFirst({
    where: { leadId: input.leadId, source: INSTANT_FORM_CONSENT_SOURCE },
    orderBy: { createdAt: "asc" },
    select: { status: true },
  });
  if (existing)
    return { status: existing.status === "PENDING" ? "NONE" : existing.status, reason: "ALREADY_RECORDED" };

  const response = input.responses?.find((r) => r.key === form.consentKey) ?? null;
  let status: "GRANTED" | "DENIED";
  let basis: FormConsentBasis;
  if (response) {
    status = response.checked ? "GRANTED" : "DENIED";
    basis = "CHECKBOX_RESPONSE";
  } else if (form.consentRequired) {
    status = "GRANTED";
    basis = "REQUIRED_CHECKBOX";
  } else {
    return { status: "NONE", reason: "NO_RESPONSE" };
  }
  const submittedAt = parseMetaTime(input.submittedAt) ?? new Date();
  await tx.consentRecord.create({
    data: {
      leadId: input.leadId,
      workspaceId: input.workspaceId,
      type: "DATA_PROCESSING",
      status,
      consentText: form.consentText,
      acceptedAt: status === "GRANTED" ? submittedAt : null,
      ip: null,
      userAgent: null,
      source: INSTANT_FORM_CONSENT_SOURCE,
      evidence: {
        metaFormId: form.metaFormId,
        leadgenId: input.leadgenId,
        checkboxKey: form.consentKey,
        basis,
        response: response ? (response.checked ? "checked" : "unchecked") : null,
        language: form.language,
        campaignId: form.campaignId,
        privacyPolicyUrl: form.privacyPolicyUrl,
        submittedAt: submittedAt.toISOString(),
      },
    },
  });
  return { status, reason: "RECORDED", basis };
}

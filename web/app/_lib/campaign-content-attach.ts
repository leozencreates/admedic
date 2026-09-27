import type { Prisma } from "@admedic/database";
import type { PolicyResult } from "@admedic/policy";
import type { Actor } from "./auth";
import { HttpError } from "./http";
import { checkPolicyWithRules } from "./policy-loader";
import { campaignPolicyText, clinicPolicyContext } from "./campaign-workflow";
import {
  buildContentSnapshot,
  contentLanguages,
  loadApprovedDrafts,
  marketCoverage,
  marketLabel,
  parseCampaignContent,
  parsePlanShape,
  type CampaignContent,
} from "./campaign-content";

export interface ContentAttachResult {
  content: CampaignContent;
  previousDraftIds: string[];
  policy: PolicyResult;
  warnings: string[];
}

/** Yanıtlarda gösterilen içerik özeti (metinlerin tamamı stüdyoda; burada yalnızca başlıklar). */
export function summarizeContent(value: unknown) {
  const content = parseCampaignContent(value);
  if (!content) return null;
  return {
    attachedAt: content.attachedAt,
    landingUrl: content.landingUrl ?? null,
    languages: contentLanguages(content),
    drafts: content.drafts.map((d) => ({
      draftId: d.draftId,
      name: d.name,
      language: d.language,
      headlines: d.variants.map((v) => v.headline),
      formQuestions: d.instantForm?.questions.length ?? 0,
    })),
  };
}

/**
 * Onaylı stüdyo taslaklarını kampanyaya bağlar (değişmez kopya; spec 3.4/3.6). Yalnızca DRAFT/REJECTED
 * kampanyada ve planlayıcı yapısı olan kampanyada yapılabilir; içerik değişince kampanya yeniden onaya
 * gönderilmelidir. Politika kontrolü içerik dahil taze kural setiyle yeniden çalışır; yüksek risk kaydı
 * engellemez, onaya göndermeyi engeller (spec 3.5).
 */
export async function attachCampaignContent(
  tx: Prisma.TransactionClient,
  actor: Actor,
  campaign: { id: string; name: string; plan: Prisma.JsonValue | null; content: Prisma.JsonValue | null; workflowStatus: string },
  input: { draftIds: string[]; landingUrl?: string | null },
): Promise<ContentAttachResult> {
  if (!["DRAFT", "REJECTED"].includes(campaign.workflowStatus))
    throw new HttpError(409, "İçerik yalnızca taslak veya reddedilmiş kampanyada değiştirilebilir.");
  const plan = parsePlanShape(campaign.plan);
  if (!plan)
    throw new HttpError(422, "İçerik bağlamak için planlayıcıdan oluşturulmuş kampanya (pazar/ad set yapısı) gerekli.");
  const drafts = await loadApprovedDrafts(tx, actor.workspaceId, input.draftIds);
  const previous = parseCampaignContent(campaign.content);
  const landingUrl = input.landingUrl === undefined ? (previous?.landingUrl ?? null) : input.landingUrl;
  const content = buildContentSnapshot(drafts, actor, landingUrl);

  const warnings: string[] = [];
  const planLanguages = new Set(plan.markets.flatMap((m) => m.languages));
  for (const language of contentLanguages(content))
    if (!planLanguages.has(language))
      warnings.push(`${language} dilindeki taslak hiçbir pazarın dilinde değil; yayınlanmaz.`);
  for (const c of marketCoverage(plan, content)) {
    if (c.covered.length === 0)
      warnings.push(`${marketLabel(c.market)} pazarı için içerik yok (diller: ${c.languages.join(", ") || "—"}); onaya göndermeden önce ekleyin.`);
    else if (c.missing.length > 0)
      warnings.push(`${marketLabel(c.market)}: ${c.missing.join(", ")} dilinde içerik yok; bu dil hedeflenmeyecek.`);
  }

  const clinic = await clinicPolicyContext(actor.workspaceId, tx);
  const policy = await checkPolicyWithRules(
    campaignPolicyText({ name: campaign.name, plan: campaign.plan, content }),
    clinic.bannedPhrases,
    tx,
  );
  await tx.campaign.update({
    where: { id: campaign.id },
    data: {
      content: content as unknown as Prisma.InputJsonValue,
      contentDraftIds: drafts.map((d) => d.draftId),
      policyRisk: policy.risk,
      policyReport: policy as unknown as Prisma.InputJsonValue,
    },
  });
  return { content, previousDraftIds: previous?.drafts.map((d) => d.draftId) ?? [], policy, warnings };
}

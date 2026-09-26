import { prisma, Prisma } from "@admedic/database";
import { requireActor, requireRole, EDIT_ROLES } from "../../_lib/auth";
import { body, respond, sameOrigin, HttpError } from "../../_lib/http";
import { z } from "zod";
import { checkPolicyWithRules } from "../../_lib/policy-loader";
import { logAudit } from "../../_lib/audit";
import {
  buildCampaignPlan,
  CONVERSION_METHODS,
  PLAN_OBJECTIVES,
  type CampaignPlan,
} from "../../_lib/campaign-plan";
import { clinicPolicyContext } from "../../_lib/campaign-workflow";
export const maxDuration = 15;
/** Bütçe girdisi major (insan) birimdir; sunucu cent'e çevirir (ADR-0011). */
const CampaignSchema = z.object({
  name: z.string().trim().min(1).max(100),
  objective: z.enum(PLAN_OBJECTIVES).optional().default("MAX_ROAS"),
  budget: z.number().positive().max(1_000_000).optional().default(1000),
  markets: z.array(z.string().min(2).max(20)).max(10).optional(),
  languages: z.array(z.string().min(2).max(10)).max(10).optional(),
  conversionMethod: z.enum(CONVERSION_METHODS).optional(),
  ageMin: z.number().int().min(13).max(64).optional(),
  ageMax: z.number().int().min(13).max(64).optional(),
  strategy: z.enum(["CBO", "ABO"]).optional(),
  brief: z.string().trim().max(2000).optional(),
}).strict();
export async function GET() {
  return respond(async () => {
    const actor = await requireActor();
    const campaigns = await prisma.campaign.findMany({
      where: { workspaceId: actor.workspaceId },
      orderBy: { createdAt: "desc" },
      include: {
        _count: { select: { adsets: true } },
        adAccount: { select: { currency: true } },
      },
    });
    return {
      campaigns: campaigns.map(({ _count, adAccount, ...c }) => ({
        ...c,
        adSets: _count.adsets,
        // dailyBudget minor unit'tir; okunabilirlik için açık adla da döner.
        budgetCents: c.dailyBudget,
        currency: adAccount.currency,
      })),
    };
  });
}
export async function POST(request: Request) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, EDIT_ROLES);
    const input = await body(request, CampaignSchema);
    const objective = input.objective ?? "MAX_ROAS";
    const dailyBudgetCents = Math.round((input.budget ?? 1000) * 100);
    if ((input.ageMin ?? 18) < 18 || (input.ageMax ?? 54) < 18)
      throw new HttpError(422, "18 yaş altı hedefleme engellenir.");
    if ((input.ageMin ?? 18) > (input.ageMax ?? 54))
      throw new HttpError(422, "Alt yaş sınırı üst yaş sınırını aşamaz.");
    const adAccount = await prisma.adAccount.findFirst({
      where: { orgId: actor.orgId, workspaceId: actor.workspaceId, status: "ACTIVE" },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    });
    if (!adAccount) throw new HttpError(400, "Reklam hesabı bulunamadı.");
    const org = await prisma.organization.findUnique({
      where: { id: actor.orgId },
      select: { monthlyAdBudgetCap: true },
    });
    // Aylık üst sınır kontrolü: ikisi de minor unit (ADR-0011).
    if (org?.monthlyAdBudgetCap != null && dailyBudgetCents * 30 > org.monthlyAdBudgetCap)
      throw new HttpError(422, "Taslak bütçesi kuruluşun aylık üst sınırını aşıyor.");
    const clinic = await clinicPolicyContext(actor.workspaceId);
    const policyText = [input.name, input.brief ?? ""].filter((s) => s.trim()).join("\n");
    // Taslak yüksek riskle de kaydedilir; onaya gönderim (submit) yüksek riski engeller (spec 3.5).
    const policy = await checkPolicyWithRules(policyText, clinic.bannedPhrases);

    const plan: CampaignPlan | undefined =
      input.markets?.length || input.strategy
        ? buildCampaignPlan({
            objective,
            dailyBudgetCents,
            monthlyCapCents: org?.monthlyAdBudgetCap ?? undefined,
            markets: input.markets ?? [],
            ageMin: input.ageMin,
            ageMax: input.ageMax,
            languages: input.languages ?? [],
            conversionMethod: input.conversionMethod ?? "landing_form",
            strategy: input.strategy,
            brief: input.brief,
            marketLanguageOverrides: clinic.marketLanguages,
            currency: adAccount.currency,
          })
        : undefined;

    if (plan?.blocked) throw new HttpError(422, plan.blockingReasons.join(" "));
    const currency = adAccount.currency ?? "EUR";
    return prisma.$transaction(async (tx) => {
    const campaign = await tx.campaign.create({
      data: {
        adAccountId: adAccount.id,
        workspaceId: actor.workspaceId,
        name: input.name,
        objective,
        budgetType: "DAILY",
        dailyBudget: dailyBudgetCents,
        status: "PAUSED",
        policyRisk: policy.risk,
        policyReport: policy as unknown as Prisma.InputJsonValue,
        plan: plan as unknown as Prisma.InputJsonValue | undefined,
        startDate: new Date(),
        endDate: new Date(Date.now() + 30 * 86400000),
      },
    });

    if (plan) {
      // Pazar/dil başına 1 ad set (planlayıcı çıktısı); ABO'da bütçe payı cent, CBO'da null.
      for (const adSet of plan.adSets) {
        await tx.adSet.create({
          data: {
            campaignId: campaign.id,
            workspaceId: actor.workspaceId,
            name: `${input.name} — ${adSet.name}`,
            status: "PAUSED",
            bidStrategy: plan.strategy,
            dailyBudget: adSet.dailyBudgetCents,
            targeting: {
              ...adSet.targeting,
              market: adSet.market,
              languages: adSet.languages,
              conversionMethod: plan.conversionMethod,
            },
          },
        });
      }
    }

    await logAudit({
      actor,
      action: "CAMPAIGN_CREATED",
      entityType: "CAMPAIGN",
      entityId: campaign.id,
      after: {
        name: campaign.name,
        objective: campaign.objective,
        dailyBudgetCents: campaign.dailyBudget,
        currency,
        policyRisk: policy.risk,
        workflowStatus: "DRAFT",
        strategy: plan?.strategy ?? null,
        adSets: plan?.adSets.length ?? 0,
      },
    }, tx);
    return {
      campaign: {
        id: campaign.id,
        name: campaign.name,
        status: campaign.status,
        workflowStatus: campaign.workflowStatus,
        objective: campaign.objective,
        budgetCents: campaign.dailyBudget,
        budget: (campaign.dailyBudget ?? 0) / 100,
        currency,
        policyRisk: policy.risk,
        policyWarning:
          policy.risk === "MEDIUM" ? policy.findings.map((f) => f.reason).join("; ") : null,
        adSets: plan?.adSets.length ?? 0,
      },
    };
    });
  });
}

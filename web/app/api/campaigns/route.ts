import { prisma, Prisma } from "@admedic/database";
import { requireActor, requireRole, EDIT_ROLES } from "../../_lib/auth";
import { body, respond, sameOrigin, HttpError } from "../../_lib/http";
import { z } from "zod";
import { checkPolicyWithRules } from "../../_lib/policy-loader";
import { logAudit } from "../../_lib/audit";
import { buildCampaignPlan, type PlanObjective } from "../../_lib/campaign-plan";
export const maxDuration = 15;
const CampaignSchema = z.object({
  name: z.string().trim().min(1).max(100),
  objective: z.enum(["MAX_ROAS", "MAX_CONVERSIONS", "MAX_IMPRESSIONS"]).optional().default("MAX_ROAS"),
  budget: z.number().positive().max(1000000).optional().default(1000),
  markets: z.array(z.string().min(2).max(3)).max(10).optional(),
  languages: z.array(z.string().min(2).max(10)).max(10).optional(),
  conversionMethod: z.enum(["landing_form", "whatsapp", "instagram_dm"]).optional(),
  ageMin: z.number().int().min(15).max(64).optional(),
  ageMax: z.number().int().min(15).max(64).optional(),
  strategy: z.enum(["CBO", "ABO"]).optional(),
  brief: z.string().trim().max(2000).optional(),
}).strict();
export async function GET() {
  return respond(async () => {
    const actor = await requireActor();
    const campaigns = await prisma.campaign.findMany({
      where: { workspaceId: actor.workspaceId },
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { adsets: true } } },
    });
    return {
      campaigns: campaigns.map((c) => ({
        ...c,
        adSets: c._count.adsets,
        _count: undefined,
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
    const budget = input.budget ?? 1000;
    const adAccount = await prisma.adAccount.findFirst({ where: { orgId: actor.orgId } });
    if (!adAccount) throw new HttpError(400, "Reklam hesabı bulunamadı.");
    const org = await prisma.organization.findUnique({
      where: { id: actor.orgId },
      select: { monthlyAdBudgetCap: true },
    });
    if (org?.monthlyAdBudgetCap != null && budget * 30 > org.monthlyAdBudgetCap)
      throw new HttpError(422, "Taslak bütçesi kuruluşun aylık üst sınırını aşıyor.");
    const policy = await checkPolicyWithRules(input.name);

    const plan =
      input.markets?.length || input.strategy
        ? buildCampaignPlan({
            objective: input.objective as PlanObjective,
            dailyBudgetCents: Math.round(budget * 100),
            monthlyCapCents: org?.monthlyAdBudgetCap ?? undefined,
            markets: input.markets ?? [],
            ageMin: input.ageMin,
            ageMax: input.ageMax,
            languages: input.languages ?? [],
            conversionMethod: input.conversionMethod ?? "landing_form",
            strategy: input.strategy,
            brief: input.brief,
          })
        : undefined;

    const campaign = await prisma.campaign.create({
      data: {
        adAccountId: adAccount.id,
        workspaceId: actor.workspaceId,
        name: input.name,
        objective: input.objective,
        dailyBudget: budget,
        status: "PAUSED",
        policyRisk: policy.risk,
        policyReport: policy,
        plan: plan as Prisma.InputJsonValue | undefined,
        startDate: new Date(),
        endDate: new Date(Date.now() + 30 * 86400000),
      },
    });

    if (plan) {
      const targeting = {
        markets: input.markets ?? [],
        languages: input.languages ?? [],
        ageMin: input.ageMin,
        ageMax: input.ageMax,
        conversionMethod: input.conversionMethod ?? "landing_form",
      };
      const adSetNames = ["Kontrol", "Varyant A", "Varyant B"];
      await prisma.$transaction(
        adSetNames.map((label, i) =>
          prisma.adSet.create({
            data: {
              campaignId: campaign.id,
              workspaceId: actor.workspaceId,
              name: `${input.name} — ${label}`,
              status: "ACTIVE",
              bidStrategy: plan.strategy,
              dailyBudget: i === 0 ? budget : Math.round(budget / 2),
              targeting,
            },
          }),
        ),
      );
    }

    await logAudit({
      actor,
      action: "CAMPAIGN_CREATED",
      entityType: "CAMPAIGN",
      entityId: campaign.id,
      after: { name: campaign.name, objective: campaign.objective, dailyBudget: campaign.dailyBudget, policyRisk: policy.risk, workflowStatus: "DRAFT", strategy: plan?.strategy, adSets: plan ? 3 : 0 },
    });
    return { campaign: { id: campaign.id, name: campaign.name, status: campaign.status, workflowStatus: campaign.workflowStatus, objective: campaign.objective, budget: campaign.dailyBudget, policyRisk: policy.risk, adSets: plan ? 3 : 0 } };
  });
}

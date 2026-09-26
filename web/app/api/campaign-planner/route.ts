import { prisma } from "@admedic/database";
import { z } from "zod";
import { requireActor } from "../../_lib/auth";
import { body, respond, sameOrigin } from "../../_lib/http";
import {
  buildCampaignPlan,
  CONVERSION_METHODS,
  PLAN_OBJECTIVES,
} from "../../_lib/campaign-plan";
import { clinicPolicyContext } from "../../_lib/campaign-workflow";

export const maxDuration = 15;

/**
 * Planlayıcı girdileri. Yaş için 13+ kabul edilir; 18 altı istek 400 yerine
 * `blocked=true` + gerekçe ile döner (kullanıcı nedenini görür, spec 3.3).
 */
const PlannerSchema = z
  .object({
    objective: z.enum(PLAN_OBJECTIVES),
    dailyBudgetCents: z.number().int().positive().max(100_000_000),
    markets: z.array(z.string().min(2).max(20)).min(1).max(10),
    ageMin: z.number().int().min(13).max(64).optional(),
    ageMax: z.number().int().min(13).max(64).optional(),
    languages: z.array(z.string().min(2).max(10)).max(10).default([]),
    conversionMethod: z.enum(CONVERSION_METHODS).default("landing_form"),
    strategy: z.enum(["CBO", "ABO"]).optional(),
    brief: z.string().trim().max(2000).optional(),
  })
  .strict();

export async function POST(request: Request) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    const input = await body(request, PlannerSchema);
    const [org, adAccount, clinic] = await Promise.all([
      prisma.organization.findUnique({
        where: { id: actor.orgId },
        select: { monthlyAdBudgetCap: true },
      }),
      prisma.adAccount.findFirst({
        where: { orgId: actor.orgId, workspaceId: actor.workspaceId, status: "ACTIVE" },
        orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
        select: { currency: true },
      }),
      // Klinik pazar hedefleri (MarketTarget) varsa dilleri öncelikli (salt okunur).
      clinicPolicyContext(actor.workspaceId),
    ]);
    const plan = buildCampaignPlan({
      objective: input.objective,
      dailyBudgetCents: input.dailyBudgetCents,
      monthlyCapCents: org?.monthlyAdBudgetCap ?? undefined,
      markets: input.markets,
      ageMin: input.ageMin,
      ageMax: input.ageMax,
      languages: input.languages ?? [],
      conversionMethod: input.conversionMethod ?? "landing_form",
      strategy: input.strategy,
      brief: input.brief,
      marketLanguageOverrides: clinic.marketLanguages,
      currency: adAccount?.currency ?? "EUR",
    });
    return { plan };
  });
}

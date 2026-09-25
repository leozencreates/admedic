import { prisma } from "@admedic/database";
import { z } from "zod";
import { requireActor } from "../../_lib/auth";
import { body, respond, sameOrigin } from "../../_lib/http";
import {
  buildCampaignPlan,
  type PlanObjective,
} from "../../_lib/campaign-plan";

export const maxDuration = 15;

const PlannerSchema = z
  .object({
    objective: z.enum(["MAX_ROAS", "MAX_CONVERSIONS", "MAX_IMPRESSIONS"]),
    dailyBudgetCents: z.number().int().positive().max(100_000_000),
    markets: z.array(z.string().min(2).max(3)).min(1).max(10),
    ageMin: z.number().int().min(15).max(64).optional(),
    ageMax: z.number().int().min(15).max(64).optional(),
    languages: z.array(z.string().min(2).max(10)).max(10).default([]),
    conversionMethod: z
      .enum(["landing_form", "whatsapp", "instagram_dm"])
      .default("landing_form"),
    strategy: z.enum(["CBO", "ABO"]).optional(),
    brief: z.string().trim().max(2000).optional(),
  })
  .strict();

export async function POST(request: Request) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    const input = await body(request, PlannerSchema);
    const org = await prisma.organization.findUnique({
      where: { id: actor.orgId },
      select: { monthlyAdBudgetCap: true },
    });
    const plan = buildCampaignPlan({
      objective: input.objective as PlanObjective,
      dailyBudgetCents: input.dailyBudgetCents,
      monthlyCapCents: org?.monthlyAdBudgetCap ?? undefined,
      markets: input.markets,
      ageMin: input.ageMin,
      ageMax: input.ageMax,
      languages: input.languages ?? [],
      conversionMethod: input.conversionMethod ?? "landing_form",
      strategy: input.strategy,
      brief: input.brief,
    });
    return { plan };
  });
}
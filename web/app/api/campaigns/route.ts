import { prisma } from "@admedic/database";
import { requireActor } from "../../_lib/auth";
import { body, respond, sameOrigin } from "../../_lib/http";
import { z } from "zod";
export const maxDuration = 15;
const CampaignSchema = z.object({
  name: z.string().trim().min(1).max(100),
  objective: z.enum(["MAX_ROAS", "MAX_CONVERSIONS", "MAX_IMPRESSIONS"]).optional().default("MAX_ROAS"),
  budget: z.number().positive().max(1000000).optional().default(1000),
}).strict();
export async function GET() {
  return respond(async () => {
    const actor = await requireActor();
    const campaigns = await prisma.campaign.findMany({
      where: { workspaceId: actor.workspaceId },
      orderBy: { createdAt: "desc" },
    });
    return { campaigns };
  });
}
export async function POST(request: Request) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    const input = await body(request, CampaignSchema);
    const adAccount = await prisma.adAccount.findFirst({ where: { orgId: actor.orgId } });
    if (!adAccount) throw new HttpError(400, "Reklam hesabı bulunamadı.");
    const campaign = await prisma.campaign.create({
      data: {
        adAccountId: adAccount.id,
        workspaceId: actor.workspaceId,
        name: input.name,
        objective: input.objective,
        dailyBudget: input.budget,
        startDate: new Date(),
        endDate: new Date(Date.now() + 30 * 86400000),
      },
    });
    return { campaign: { id: campaign.id, name: campaign.name, status: campaign.status, objective: campaign.objective, budget: campaign.dailyBudget } };
  });
}
import { HttpError } from "../../_lib/http";

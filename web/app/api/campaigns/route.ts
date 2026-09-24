import { prisma } from "@admedic/database";
import { requireActor, requireRole, EDIT_ROLES } from "../../_lib/auth";
import { body, respond, sameOrigin, HttpError } from "../../_lib/http";
import { z } from "zod";
import { checkPolicyWithRules } from "../../_lib/policy-loader";
import { logAudit } from "../../_lib/audit";
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
        startDate: new Date(),
        endDate: new Date(Date.now() + 30 * 86400000),
      },
    });
    await logAudit({
      actor,
      action: "CAMPAIGN_CREATED",
      entityType: "CAMPAIGN",
      entityId: campaign.id,
      after: { name: campaign.name, objective: campaign.objective, dailyBudget: campaign.dailyBudget, policyRisk: policy.risk, workflowStatus: "DRAFT" },
    });
    return { campaign: { id: campaign.id, name: campaign.name, status: campaign.status, workflowStatus: campaign.workflowStatus, objective: campaign.objective, budget: campaign.dailyBudget, policyRisk: policy.risk } };
  });
}

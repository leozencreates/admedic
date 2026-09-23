import { prisma } from "@admedic/database";
import { requireActor } from "@/app/_lib/auth";
import { body, respond, sameOrigin, HttpError } from "@/app/_lib/http";
import { z } from "zod";
export const maxDuration = 10;
const SubscriptionPlanEnum = z.enum(["FREE", "STARTER", "PROFESSIONAL", "ENTERPRISE"]);
const UpdateSubscriptionSchema = z.object({
  plan: SubscriptionPlanEnum,
}).strict();
export async function GET() {
  return respond(async () => {
    const actor = await requireActor();
    const sub = await prisma.subscription.findFirst({
      where: { organizationId: actor.orgId },
    });
    if (!sub) throw new HttpError(404, "Abonelik bulunamadı.");
    return { subscription: { plan: sub.plan, status: sub.status, currentPeriodStart: sub.currentPeriodStart, currentPeriodEnd: sub.currentPeriodEnd, cancelAtPeriodEnd: sub.cancelAtPeriodEnd } };
  });
}
export async function PATCH(request: Request) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    const input = await body(request, UpdateSubscriptionSchema);
    const sub = await prisma.subscription.findFirst({
      where: { organizationId: actor.orgId },
    });
    if (!sub) throw new HttpError(404, "Abonelik bulunamadı.");
    const now = new Date();
    const periodStart = sub.status === "ACTIVE" ? new Date(Math.max(sub.currentPeriodEnd.getTime(), now.getTime())) : now;
    const periodEnd = new Date(periodStart);
    periodEnd.setMonth(periodEnd.getMonth() + 1);
    await prisma.subscription.update({
      where: { id: sub.id },
      data: { plan: input.plan, status: "ACTIVE", currentPeriodStart: periodStart, currentPeriodEnd: periodEnd },
    });
    await prisma.invoice.create({
      data: {
        subscriptionId: sub.id,
        organizationId: actor.orgId,
        amountCents: input.plan === "FREE" ? 0 : input.plan === "STARTER" ? 2990 : input.plan === "PROFESSIONAL" ? 9990 : 24990,
        currency: "EUR",
        status: "DRAFT",
        issuedAt: now,
        dueAt: new Date(now.getTime() + 30 * 86400000),
      },
    });
    return { subscription: { plan: input.plan, status: "ACTIVE" } };
  });
}

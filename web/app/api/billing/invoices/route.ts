import { prisma } from "@admedic/database";
import { requireActor } from "../../../_lib/auth";
import { body, respond, sameOrigin, HttpError } from "../../../_lib/http";
export const maxDuration = 10;
export async function GET() {
  return respond(async () => {
    const actor = await requireActor();
    const invoices = await prisma.invoice.findMany({
      where: { organizationId: actor.orgId },
      orderBy: { issuedAt: "desc" }, take: 20,
    });
    return { invoices: invoices.map((inv) => ({ id: inv.id, amountCents: inv.amountCents, currency: inv.currency, status: inv.status, issuedAt: inv.issuedAt, dueAt: inv.dueAt, paidAt: inv.paidAt })) };
  });
}

import { prisma } from "@admedic/database";
import { requireActor } from "../../../../../_lib/auth";
import { respond, sameOrigin, HttpError } from "../../../../../_lib/http";
export const maxDuration = 10;
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    const { id } = await params;
    const invoice = await prisma.invoice.findFirst({
      where: { id, organizationId: actor.orgId },
    });
    if (!invoice) throw new HttpError(404, "Fatura bulunamadı.");
    if (invoice.status !== "DRAFT") throw new HttpError(409, "Fatura zaten işlenmiş.");
    await prisma.invoice.update({ where: { id }, data: { status: "PAID", paidAt: new Date() } });
    await prisma.subscription.update({ where: { organizationId: actor.orgId }, data: { status: "ACTIVE" } });
    return { ok: true, status: "PAID" };
  });
}

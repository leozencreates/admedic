import { z } from "zod";
import { prisma } from "@admedic/database";
import { requireActor, requireRole } from "../../../_lib/auth";
import { body, respond, sameOrigin, HttpError } from "../../../_lib/http";
import { logAudit } from "../../../_lib/audit";
import { billingMode } from "../_lib/stripe";
import { markInvoicePaid, serializeInvoice } from "../_lib/billing";

export const maxDuration = 10;

export async function GET() {
  return respond(async () => {
    const actor = await requireActor();
    const invoices = await prisma.invoice.findMany({
      where: { organizationId: actor.orgId },
      orderBy: { issuedAt: "desc" },
      take: 20,
    });
    return { invoices: invoices.map(serializeInvoice), mock: billingMode().mock };
  });
}

const InvoiceActionSchema = z
  .object({
    invoiceId: z.string().min(1).max(64),
    action: z.literal("mark-paid"),
  })
  .strict();

/**
 * Fatura işlemleri. `mark-paid`: OWNER/ADMIN, yalnızca mock modda elle "ödendi" (ödeme simülasyonu);
 * gerçek modda faturalar Stripe üzerinden ödenir → 409. Tenant dışı fatura 404. Audit zorunlu.
 * (Eski `invoices/[id]/pay` rotası teslimat derinliği kısıtı nedeniyle burada yeniden kuruldu.)
 */
export async function POST(request: Request) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, ["OWNER", "ADMIN"]);
    const input = await body(request, InvoiceActionSchema);
    const { mock } = billingMode();
    if (!mock) throw new HttpError(409, "Faturalar Stripe üzerinden ödenir; elle ödeme yalnızca mock modda kullanılabilir.");
    const invoice = await prisma.invoice.findFirst({ where: { id: input.invoiceId, organizationId: actor.orgId } });
    if (!invoice) throw new HttpError(404, "Fatura bulunamadı.");
    if (invoice.status === "PAID") throw new HttpError(409, "Fatura zaten ödenmiş.");
    if (invoice.status === "VOID") throw new HttpError(409, "İptal edilmiş fatura ödenemez.");
    const paid = await prisma.$transaction(async (tx) => {
      const updated = await markInvoicePaid(tx, invoice);
      await logAudit(
        {
          actor,
          action: "INVOICE_PAID",
          entityType: "INVOICE",
          entityId: invoice.id,
          before: { status: invoice.status },
          after: { status: "PAID", amountCents: invoice.amountCents, currency: invoice.currency, mock: true },
        },
        tx,
      );
      return updated;
    });
    return { ok: true, invoice: serializeInvoice(paid), mock: true };
  });
}

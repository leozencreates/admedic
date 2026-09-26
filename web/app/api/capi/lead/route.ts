import { prisma } from "@admedic/database";
import { requireActor, requireRole, EDIT_ROLES } from "../../../_lib/auth";
import { body, respond, sameOrigin, HttpError } from "../../../_lib/http";
import { healthAllowedEvents, LEAD_STATUS_EVENT, META_ACTION_SOURCES, type InternalConversionEvent } from "@admedic/meta-api";
import { z } from "zod";
import { sendLeadConversion } from "../../../_lib/capi-sync";

export const maxDuration = 15;

/**
 * Lead için CRM (offline) dönüşümü (spec 3.9). `eventName` verilmezse lead'in durumundan
 * türetilir (CONTACTED→Contact, QUALIFIED→Lead, CONSULTATION_BOOKED→Schedule,
 * TRAVEL_PLANNED→CompleteRegistration, TREATED→Purchase). Rıza kapısı, Pixel/Dataset hedefi ve
 * idempotency `capi-sync.ts` içindedir.
 */
const LeadConversionSchema = z
  .object({
    leadId: z.string().min(1),
    eventName: z.enum(["LEAD", "SCHEDULE", "COMPLETE_REGISTRATION", "CONTACT", "PURCHASE"]).optional(),
    actionSource: z.enum(META_ACTION_SOURCES).optional(),
    value: z.number().positive().optional(),
    currency: z.string().length(3).optional(),
  })
  .strict();

export async function POST(request: Request) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, EDIT_ROLES);
    const input = await body(request, LeadConversionSchema);

    const lead = await prisma.lead.findFirst({ where: { id: input.leadId, workspaceId: actor.workspaceId } });
    if (!lead) throw new HttpError(404, "Lead bulunamadı.");
    if (lead.status === "LOST") throw new HttpError(409, "Kayıp lead'e dönüşüm gönderilemez.");

    const eventName: InternalConversionEvent | null = input.eventName ?? LEAD_STATUS_EVENT[lead.status] ?? null;
    if (!eventName) throw new HttpError(422, `Bu lead durumu için gönderilecek dönüşüm olayı yok: ${lead.status}`);
    if (!healthAllowedEvents().includes(eventName)) throw new HttpError(422, `Olay adı izin verilmiyor: ${eventName}`);

    const currency = input.value !== undefined ? (input.currency ?? (await defaultCurrency(actor.workspaceId))) : undefined;
    const result = await sendLeadConversion({
      lead,
      eventName,
      value: input.value,
      currency,
      actionSource: input.actionSource,
      actor,
    });
    switch (result.status) {
      case "SENT":
        return { eventId: result.eventId, status: "ACCEPTED" as const, duplicate: false, conversionEventId: result.conversionEventId, eventsReceived: result.eventsReceived, mock: result.mock };
      case "DUPLICATE":
        return { eventId: result.eventId, status: "DUPLICATE" as const, duplicate: true, conversionEventId: result.conversionEventId };
      case "SKIPPED":
        if (result.reason === "NO_CONSENT") throw new HttpError(409, result.message ?? "Rıza yok.");
        if (result.reason === "NO_PIXEL") throw new HttpError(400, "Pixel/Dataset ID ayarlanmadı.");
        if (result.reason === "LEAD_LOST") throw new HttpError(409, result.message ?? "Kayıp lead.");
        throw new HttpError(422, result.message ?? "Dönüşüm gönderilmedi.");
      default:
        throw new HttpError(result.reason === "CONNECTION" ? 400 : 502, result.message ?? "Meta CAPI isteği başarısız.");
    }
  });
}

async function defaultCurrency(workspaceId: string): Promise<string> {
  const account = await prisma.adAccount.findFirst({ where: { workspaceId }, orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }], select: { currency: true } });
  if (account?.currency) return account.currency;
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { currency: true } });
  return ws?.currency ?? "EUR";
}

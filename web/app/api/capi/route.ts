import { prisma } from "@admedic/database";
import { requireActor } from "../../_lib/auth";
import { body, respond, sameOrigin, HttpError } from "../../_lib/http";
import { z } from "zod";

const CapiSchema = z
  .object({
    eventName: z.string().min(1),
    eventTime: z.string().datetime(),
    actionSource: z.string().min(1),
    userData: z
      .object({
        clientIp: z.string().optional(),
        clientUserAgent: z.string().optional(),
        em: z.string().optional(),
        ph: z.string().optional(),
      })
      .optional(),
    customData: z.record(z.unknown()).optional(),
    eventSourceURL: z.string().optional(),
  })
  .strict();

const HEALTH_ALLOWED_EVENTS = new Set([
  "PURCHASE",
  "ADD_TO_CART",
  "LEAD",
  "INITIATE_CHECKOUT",
  "COMPLETE_REGISTRATION",
  "CONTENT",
  "VIEW_CONTENT",
  "SEARCH",
  "CUSTOMIZE_PRODUCT",
  "ADD_PAYMENT_INFO",
  "DONATE",
]);

export async function POST(request: Request) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    const input = await body(request, CapiSchema);
    const { eventName } = input;

    if (!HEALTH_ALLOWED_EVENTS.has(eventName)) {
      throw new HttpError(
        422,
        `Bu olay türü sağlık kategorisi için izin verilmiyor: ${eventName}`,
      );
    }

    const event = await prisma.conversionEvent.create({
      data: {
        workspaceId: actor.workspaceId,
        type: eventName,
        occurredAt: new Date(input.eventTime),
        source: "META",
        value: (input.customData?.value as number | null) ?? null,
        currency: (input.customData?.currency as string | null) ?? null,
      },
    });

    return { eventId: event.id, status: "ACCEPTED" as const };
  });
}

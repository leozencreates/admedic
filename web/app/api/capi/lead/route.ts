import { prisma } from "@admedic/database";
import { requireActor, requireRole, EDIT_ROLES } from "../../../_lib/auth";
import { body, respond, sameOrigin, HttpError } from "../../../_lib/http";
import { postConversionEvents, healthAllowedEvents } from "@admedic/meta-api";
import { loadEnv } from "@admedic/config";
import { z } from "zod";
import { logAudit } from "../../../_lib/audit";
import { checkPolicy } from "@admedic/policy";
import { requireLiveMetaConnection } from "../../../_lib/meta-connection";
import { createMetaClient, MOCK_AD_ACCOUNT_ID } from "@admedic/meta-api";

export const maxDuration = 15;

const LeadConversionSchema = z.object({
  leadId: z.string().min(1),
  eventName: z.enum(["PURCHASE", "ADD_TO_CART", "LEAD", "INITIATE_CHECKOUT", "CUSTOMIZE"]),
  value: z.number().positive().optional(),
  currency: z.string().default("TRY"),
});

export async function POST(request: Request) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, ["OWNER", "ADMIN", "MEDIA_BUYER"]);
    const input = await body(request, LeadConversionSchema);
    const env = loadEnv();

    const lead = await prisma.lead.findUnique({
      where: { id: input.leadId, workspaceId: actor.workspaceId },
    });
    if (!lead) throw new HttpError(404, "Lead bulunamadı.");
    if (lead.status === "LOST") throw new HttpError(409, "Kayıp lead'e dönüşüm gönderilemez.");

    const policy = checkPolicy(lead.firstName);
    if (policy.risk === "HIGH") throw new HttpError(422, "Bu lead için içerik kontrol riskli.");

    const allowed = healthAllowedEvents();
    if (!allowed.includes(input.eventName)) throw new HttpError(400, `Olay adı izin verilmiyor: ${input.eventName}`);

    const campaignId = lead.campaignId;
    if (!campaignId) throw new HttpError(400, "Kampanya bağlantısı yapılandırılmadı.");
    const campaign = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { adAccountId: true } });
    if (!campaign?.adAccountId) throw new HttpError(400, "Kampanya bağlantısı yapılandırılmadı.");
    const adAccount = await prisma.adAccount.findUnique({ where: { id: campaign.adAccountId } });
    if (!adAccount?.connectionId) throw new HttpError(400, "Meta bağlantısı yapılandırılmadı.");
    const live = await requireLiveMetaConnection(adAccount.connectionId, actor.orgId);
    const token = live.token;
    const metaAccountId = (adAccount.metaAccountId ?? MOCK_AD_ACCOUNT_ID).replace(/^act_/, "");
    const meta = createMetaClient();

    const externalId = `crm_${lead.id}_${input.eventName}_${Date.now()}`;
    const metaResult = await postConversionEvents(
      metaAccountId,
      [
        {
          eventName: input.eventName,
          eventTime: new Date().toISOString(),
          actionSource: input.eventName === "LEAD" ? "offline_conversion" : "website",
          eventId: externalId,
          userData: { external_id: lead.lookupHash ?? undefined },
          customData: {
            leadId: lead.id,
            status: lead.status,
            service: lead.interestedService ?? undefined,
            value: input.value,
            currency: input.currency,
          },
          eventSourceURL: env.AUTH_URL ?? "http://localhost:3000",
        },
      ],
      token,
    ).catch(() => null);

    const conversionEvent = await prisma.conversionEvent.create({
      data: {
        workspaceId: actor.workspaceId,
        campaignId: lead.campaignId ?? undefined,
        adSetId: lead.adSetId ?? undefined,
        adId: lead.adId ?? undefined,
        type: input.eventName,
        value: input.value ? Math.round(input.value) : undefined,
        currency: input.currency,
        source: "CRM",
        externalId,
        occurredAt: new Date(),
      },
    });
    await logAudit({
      actor,
      action: "CRM_CONVERSION",
      entityType: "CONVERSION_EVENT",
      entityId: conversionEvent.id,
      after: { eventName: input.eventName, leadId: lead.id, source: "CRM", metaResult: metaResult?.data?.[0]?.eventId },
    });
    return { eventId: externalId, status: metaResult?.data?.[0]?.eventId ? "ACCEPTED" : "STORED", conversionEventId: conversionEvent.id };
  });
}

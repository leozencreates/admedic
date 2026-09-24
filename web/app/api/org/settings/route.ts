import { prisma } from "@admedic/database";
import { requireActor, requireRole } from "../../../_lib/auth";
import { body, respond, sameOrigin } from "../../../_lib/http";
import { z } from "zod";
import { logAudit } from "../../../_lib/audit";
export const maxDuration = 10;
const OrgSettingsSchema = z
  .object({
    retentionDays: z.number().int().min(30).max(3650).optional(),
    consentText: z.string().max(4000).optional().nullable(),
  })
  .strict();
export async function GET() {
  return respond(async () => {
    const actor = await requireActor();
    const org = await prisma.organization.findUnique({
      where: { id: actor.orgId },
      select: { retentionDays: true, consentText: true },
    });
    return { settings: org };
  });
}
export async function PATCH(request: Request) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, ["OWNER", "ADMIN"]);
    const input = await body(request, OrgSettingsSchema);
    const before = await prisma.organization.findUnique({
      where: { id: actor.orgId },
      select: { retentionDays: true, consentText: true },
    });
    const org = await prisma.organization.update({
      where: { id: actor.orgId },
      data: {
        ...(input.retentionDays !== undefined
          ? { retentionDays: input.retentionDays }
          : {}),
        ...(input.consentText !== undefined
          ? { consentText: input.consentText }
          : {}),
      },
      select: { retentionDays: true, consentText: true },
    });
    await logAudit({
      actor,
      action: "ORG_SETTINGS_UPDATED",
      entityType: "ORGANIZATION",
      entityId: actor.orgId,
      before,
      after: org,
    });
    return { settings: org };
  });
}
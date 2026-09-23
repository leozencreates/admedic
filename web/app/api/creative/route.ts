import { prisma } from "@admedic/database";
import { requireActor, requireRole, EDIT_ROLES } from "../../_lib/auth";
import { body, respond, sameOrigin } from "../../_lib/http";
import { z } from "zod";
import { loadEnv } from "@admedic/config";
import { logAudit } from "../../_lib/audit";
export const maxDuration = 30;
const CreativeSchema = z.object({ name: z.string().trim().min(1).max(100) }).strict();
export async function GET() {
  return respond(async () => {
    const actor = await requireActor();
    const creatives = await prisma.creative.findMany({
      where: { workspaceId: actor.workspaceId },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    return { creatives };
  });
}
export async function POST(request: Request) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, EDIT_ROLES);
    const input = await body(request, CreativeSchema);
    loadEnv();
    const creative = await prisma.creative.create({
      data: {
        workspaceId: actor.workspaceId,
        orgId: actor.orgId,
        name: input.name,
        status: "DRAFT",
        type: "IMAGE",
      },
    });
    await logAudit({
      actor,
      action: "CREATIVE_CREATED",
      entityType: "CREATIVE",
      entityId: creative.id,
      after: { name: creative.name, status: creative.status, type: creative.type },
    });
    return { creative: { id: creative.id, name: creative.name, status: creative.status, type: creative.type } };
  });
}
import { HttpError } from "../../_lib/http";

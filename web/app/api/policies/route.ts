import { prisma } from "@admedic/database";
import { requireActor } from "../../_lib/auth";
import { respond, sameOrigin } from "../../_lib/http";
import { loadEnv } from "@admedic/config";
export const maxDuration = 15;
export async function GET() {
  return respond(async () => {
    const actor = await requireActor();
    loadEnv();
    const policies = await prisma.optimizationPolicy.findMany({ where: { workspaceId: actor.workspaceId }, orderBy: { createdAt: "desc" } });
    const rules = await prisma.optimizationRule.findMany({ where: { workspaceId: actor.workspaceId }, orderBy: { createdAt: "desc" } });
    return { policies, rules };
  });
}
import { HttpError } from "../../_lib/http";

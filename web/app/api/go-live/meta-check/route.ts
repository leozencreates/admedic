import { quota, requireActor, requireRole } from "../../../_lib/auth";
import { respond, sameOrigin } from "../../../_lib/http";
import { logAudit } from "../../../_lib/audit";
import { metaChecks } from "../../../_lib/go-live";

export const maxDuration = 60;

/**
 * Meta bağlantılarının canlı, salt okunur denetimi (ADR-0023): token, izinler, reklam hesapları, eşlemeler.
 * Meta'ya hiçbir şey yazılmaz. Yalnızca hesap sahibi; Meta istek kotasını korumak için saatte 10 kez.
 */
export async function POST(request: Request) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, ["OWNER"]);
    await quota(`go-live:${actor.orgId}`, 10, 3600);
    const result = await metaChecks(actor.orgId);
    const counts = result.connections.flatMap((c) => c.checks).reduce(
      (acc, c) => ({ ...acc, [c.status]: (acc[c.status] ?? 0) + 1 }),
      {} as Record<string, number>,
    );
    await logAudit({
      actor,
      action: "GO_LIVE_META_CHECK",
      entityType: "ORGANIZATION",
      entityId: actor.orgId,
      before: {},
      after: { live: result.live, connections: result.connections.length, ...counts },
    });
    return { ...result, checkedAt: new Date().toISOString() };
  });
}

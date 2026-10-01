import { TEAMS, TEAM_SIZE } from "@admedic/lead-team";
import { requireActor, requireRole, EDIT_ROLES } from "../../_lib/auth";
import { respond, sameOrigin } from "../../_lib/http";
import { runAfterResponse } from "../../_lib/after-response";
import { DAILY_RUN_LIMIT, executeLeadTeamRun, leadTeamOverview, startLeadTeamRun } from "../../_lib/lead-team";

export const maxDuration = 30;

/** Menüde sayfayı görebilen roller (nav-tree ANALYZE ile aynı). */
const VIEW_ROLES = [...EDIT_ROLES, "ANALYST"] as const;

/**
 * Lead takımı (ADR-0029).
 * - GET: kadro, son çalıştırmalar, en son çalıştırmanın ajan raporları ve direktör önerileri.
 * - POST: takımı çalıştırır (hesap sahibi, yönetici, reklam uzmanı). 50 ajan yanıt gönderildikten sonra çalışır;
 *   ilerleme GET ile izlenir. Ajanlar Meta'ya yazmaz ve harcama yapmaz.
 */
export async function GET() {
  return respond(async () => {
    const actor = await requireActor();
    requireRole(actor, [...VIEW_ROLES]);
    const overview = await leadTeamOverview(actor);
    return {
      canRun: EDIT_ROLES.includes(actor.role),
      canDecide: actor.role === "OWNER" || actor.role === "ADMIN",
      dailyRunLimit: DAILY_RUN_LIMIT,
      teamSize: TEAM_SIZE,
      teams: TEAMS.map((team) => ({
        key: team.key,
        title: team.title,
        specialists: team.specialists.map((s) => ({ key: `${team.key}:${s.key}`, title: s.title })),
      })),
      ...overview,
    };
  });
}

export async function POST(request: Request) {
  return respond(async () => {
    sameOrigin(request);
    const actor = await requireActor();
    requireRole(actor, EDIT_ROLES);
    const run = await startLeadTeamRun(actor);
    await runAfterResponse("lead-team", () => executeLeadTeamRun(run.id));
    return { run };
  });
}

import { requireActor, requireRole } from "../../_lib/auth";
import { respond } from "../../_lib/http";
import { configChecks, endToEndChecks } from "../../_lib/go-live";

/** Canlıya geçiş denetimi (ADR-0023): sunucu yapılandırması ve uçtan uca kanıtlar. Yalnızca hesap sahibi. */
export async function GET() {
  return respond(async () => {
    const actor = await requireActor();
    requireRole(actor, ["OWNER"]);
    const [config, e2e] = await Promise.all([configChecks(), endToEndChecks(actor.orgId)]);
    return { config, e2e };
  });
}

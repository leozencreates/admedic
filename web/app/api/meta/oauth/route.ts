import { requireActor, requireRole } from "../../../_lib/auth";
import { respond, HttpError } from "../../../_lib/http";
import { loadEnv } from "@admedic/config";
import { createOAuthState } from "../../../_lib/oauth-state";
import { getGraphVersion } from "@admedic/meta-api";
import { META_OAUTH_SCOPES } from "../../../_lib/meta-scopes";
export const maxDuration = 15;
/**
 * Meta Business Login başlatma: imzalı state üretir ve dialog URL'sini döner.
 * GET isteğinde tarayıcı Origin başlığı göndermediği için `sameOrigin` KULLANILMAZ;
 * CSRF koruması HMAC imzalı, süreli ve tek kullanımlık state ile sağlanır.
 * Not: "Business" tipi uygulamalarda Facebook Login for Business `scope` yerine
 * `config_id` ister (docs/meta-constraints.md 2026-09-26, DOĞRULANMADI); gerekirse
 * `META_LOGIN_CONFIG_ID` ortam değişkeniyle bu URL'ye eklenmelidir.
 */
export async function GET(_request: Request) {
  return respond(async () => {
    const actor = await requireActor();
    requireRole(actor, ["OWNER", "ADMIN"]);
    const env = loadEnv();
    if (!env.META_APP_ID)
      throw new HttpError(
        400,
        "Meta uygulama kimliği ayarlanmamış (META_APP_ID); Meta bağlantısı başlatılamıyor. Sistem yöneticinize bildirin.",
      );
    const { state } = createOAuthState(env.AUTH_SECRET, actor.userId, actor.orgId);
    const scopes = [...META_OAUTH_SCOPES];
    const version = getGraphVersion();
    const url = `https://www.facebook.com/${version}/dialog/oauth?client_id=${encodeURIComponent(env.META_APP_ID)}&redirect_uri=${encodeURIComponent(env.META_REDIRECT_URI)}&state=${encodeURIComponent(state)}&scope=${scopes.join(",")}`;
    return { authUrl: url, appId: env.META_APP_ID, apiVersion: version };
  });
}

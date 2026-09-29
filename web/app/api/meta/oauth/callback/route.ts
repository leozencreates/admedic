import { prisma } from "@admedic/database";
import { errorToHttp, HttpError } from "../../../../_lib/http";
import { requireActor, requireRole } from "../../../../_lib/auth";
import { loadEnv } from "@admedic/config";
import {
  parseOAuthState,
  consumeOAuthState,
  isOAuthStateUsedError,
} from "../../../../_lib/oauth-state";
import { encrypt } from "../../../../_lib/encrypt";
import {
  META_OAUTH_SCOPES,
  optionalScopesMissing,
  requiredScopesMissing,
} from "../../../../_lib/meta-scopes";
import {
  fetchPageAccounts,
  graphGetAuthed,
  mockDiscoveredPages,
  syncDiscoveredAdAccounts,
  syncPageConnections,
  subscribeDiscoveredPages,
} from "../../../../_lib/meta-connection";
import { logAudit } from "../../../../_lib/audit";
import { runAfterResponse } from "../../../../_lib/after-response";
import { refetchPendingLeads } from "../../../../_lib/lead-refetch";
import {
  createMetaClient,
  exchangeUserToken,
  getGraphVersion,
  getGrantedPermissions,
  rawGraph,
} from "@admedic/meta-api";
import { logger } from "../../../../_lib/log";
// Yanıttan sonra bekleyen lead çekimleri de bu süre içinde çalışır (after).
export const maxDuration = 30;

type Env = ReturnType<typeof loadEnv>;

/**
 * Kullanıcıyı bağlantı sayfasına 303 ile geri yollar. Callback JSON döndürmez:
 * kullanıcı tarayıcıda Meta'dan döner, sonucu sayfa `status/missing/optional/reason`
 * sorgu parametrelerinden okur.
 */
function redirectToConnections(env: Env, params: Record<string, string | undefined>) {
  const url = new URL("/meta-connections", env.AUTH_URL);
  for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
  return new Response(null, {
    status: 303,
    headers: { Location: url.toString(), "Cache-Control": "no-store" },
  });
}

interface CallbackResult {
  missing: string[];
  optionalMissing: string[];
  pages: number;
  adAccounts: number;
}

export async function GET(request: Request) {
  const env = loadEnv();
  try {
    const result = await handleCallback(request, env);
    return redirectToConnections(env, {
      status: "connected",
      missing: result.missing.join(",") || undefined,
      optional: result.optionalMissing.join(",") || undefined,
      pages: String(result.pages),
      accounts: String(result.adAccounts),
    });
  } catch (error) {
    const mapped = errorToHttp(error);
    if (mapped.status >= 500 && !(error instanceof HttpError)) {
      const code = (error as { code?: unknown } | null)?.code;
      logger.error(
        `[oauth] ${error instanceof Error ? error.name : "Error"}${code ? ` ${String(code)}` : ""}: ${
          error instanceof Error ? error.message.slice(0, 200) : "unknown"
        }`,
      );
    }
    return redirectToConnections(env, { status: "error", reason: mapped.message });
  }
}

async function handleCallback(request: Request, env: Env): Promise<CallbackResult> {
  const actor = await requireActor();
  requireRole(actor, ["OWNER", "ADMIN"]);
  const url = new URL(request.url);
  const error = url.searchParams.get("error");
  if (error) {
    const description = url.searchParams.get("error_description");
    throw new HttpError(
      400,
      `Meta yetkisi verilmedi: ${error}${description ? ` (${description})` : ""}`,
    );
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code) throw new HttpError(400, "Meta yetkilendirme kodu alınamadı.");
  if (!state) throw new HttpError(400, "OAuth state eksik.");

  const parsed = parseOAuthState(state, env.AUTH_SECRET);
  if (!parsed)
    throw new HttpError(400, "OAuth state doğrulanamadı veya süresi dolmuş.");
  if (parsed.userId !== actor.userId || parsed.orgId !== actor.orgId)
    throw new HttpError(403, "OAuth oturumu bu bağlantı isteğiyle eşleşmiyor.");
  try {
    await consumeOAuthState(parsed.orgId, parsed.nonce);
  } catch (e) {
    if (isOAuthStateUsedError(e))
      throw new HttpError(400, "OAuth isteği zaten işlenmiş.");
    throw e;
  }
  if (!env.META_APP_ID || !env.META_APP_SECRET)
    throw new HttpError(
      400,
      "Meta uygulama kimlik bilgileri ayarlanmamış (META_APP_ID/META_APP_SECRET).",
    );

  // 1) Kod → erişim token'ı (uç tanımı gereği client_secret ve code sorgu parametresidir).
  //    Graph sürümü ortamdan çözülür (sabit yazılmaz); ayarsızsa açık hata.
  const tokenUrl = new URL(
    `https://graph.facebook.com/${getGraphVersion()}/oauth/access_token`,
  );
  tokenUrl.searchParams.set("client_id", env.META_APP_ID);
  tokenUrl.searchParams.set("redirect_uri", env.META_REDIRECT_URI);
  tokenUrl.searchParams.set("client_secret", env.META_APP_SECRET);
  tokenUrl.searchParams.set("code", code);
  let accessToken: string;
  let expiresAt: Date | null;
  try {
    const tokenRes = await rawGraph(tokenUrl.toString());
    const tokenData = isRecord(tokenRes.body) ? tokenRes.body : {};
    if (typeof tokenData.access_token !== "string" || tokenData.access_token.length === 0)
      throw new HttpError(400, "Meta erişim tokenı alınamadı.");
    accessToken = tokenData.access_token;
    expiresAt = ttlToDate(tokenData.expires_in);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, `Meta erişim tokenı alınamadı: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 2) Uzun ömürlü kullanıcı token'ı (~60 gün); sayfa token'ları bununla alınırsa süresiz olur.
  //    Başarısızlık kritik değil: kısa ömürlü token ile devam edilir, worker yenilemeyi dener.
  let longLived = false;
  try {
    const exchanged = await exchangeUserToken(accessToken);
    accessToken = exchanged.accessToken;
    expiresAt = exchanged.expiresAt ?? expiresAt;
    longLived = true;
  } catch (e) {
    logger.warn(`[oauth] uzun ömürlü token değişimi başarısız: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`);
  }

  // 3) Verilen izinler: kod değişimi yanıtında `granted_scopes` gelmez → /me/permissions.
  const permissions = await getGrantedPermissions(accessToken, {
    mock: env.META_MOCK_MODE,
    mockGranted: META_OAUTH_SCOPES,
  });
  const grantedScopes = permissions.granted;
  const missingPermissions = requiredScopesMissing(grantedScopes);
  const optionalMissing = optionalScopesMissing(grantedScopes);

  // 4) Kullanıcı kimliği.
  const me = await graphGetAuthed("me", { fields: "id,name" }, accessToken).catch(() => null);
  const metaUserId = isRecord(me) && me.id !== undefined ? String(me.id) : null;
  let accountName = isRecord(me) && me.name ? String(me.name) : null;
  if (!metaUserId) throw new HttpError(400, "Meta kullanıcı bilgisi alınamadı.");

  // 5) Business Manager keşfi (kritik değil).
  let metaAccountId: string | null = null;
  try {
    const bm = await graphGetAuthed("me/businesses", { fields: "id,name" }, accessToken);
    const first = isRecord(bm) && Array.isArray(bm.data) ? bm.data[0] : null;
    if (isRecord(first) && first.id !== undefined) {
      metaAccountId = String(first.id);
      if (first.name) accountName = String(first.name);
    }
  } catch {
    // Business Manager keşfi kritik değil; bağlantı yine de kurulur.
  }

  const data = {
    status: "CONNECTED" as const,
    name: accountName,
    metaAccountId,
    metaUserId,
    tokenCiphertext: encrypt(accessToken),
    scopes: grantedScopes,
    appId: env.META_APP_ID,
    expiresAt: expiresAt ?? new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
    missingPermissions,
    lastError: null as string | null,
  };

  const existing = await prisma.metaConnection.findFirst({
    where: { orgId: actor.orgId, type: "BUSINESS_MANAGER" },
    select: { id: true },
  });
  let connectionId: string;
  if (existing) {
    await prisma.metaConnection.update({ where: { id: existing.id }, data });
    connectionId = existing.id;
  } else {
    const created = await prisma.metaConnection.create({
      data: { orgId: actor.orgId, type: "BUSINESS_MANAGER", ...data },
    });
    connectionId = created.id;
  }

  // 6) Sayfa / Instagram bağlantıları (pages_show_list). Mock modda deterministik sahte sayfa.
  let pages = 0;
  if (env.META_MOCK_MODE || grantedScopes.includes("pages_show_list")) {
    try {
      const discovered = env.META_MOCK_MODE
        ? mockDiscoveredPages()
        : await fetchPageAccounts(accessToken);
      const synced = await syncPageConnections(actor.orgId, discovered, {
        metaUserId,
        appId: env.META_APP_ID,
        scopes: grantedScopes,
        // Uzun ömürlü kullanıcı token'ından alınan sayfa token'ları süresizdir.
        expiresAt: longLived ? null : data.expiresAt,
      });
      pages = synced.created + synced.updated;
      // Lead ve mesaj bildirimleri için sayfalar uygulamaya abone edilir (ADR-0023); hata bağlantıya yazılır.
      if (!env.META_MOCK_MODE) {
        const subscription = await subscribeDiscoveredPages(actor.orgId, discovered, grantedScopes);
        if (subscription.failed)
          logger.warn({ failed: subscription.failed, subscribed: subscription.subscribed }, "[oauth] sayfa webhook aboneliği kısmen başarısız");
      }
      // Sayfa token'ları yenilendi: alanları daha önce çekilemeyen lead'ler yanıttan sonra yeniden denenir.
      if (pages > 0)
        await runAfterResponse("lead-refetch", () =>
          refetchPendingLeads({ orgId: actor.orgId, limit: 25, budgetMs: 12_000, force: true }),
        );
    } catch (err) {
      logger.warn(`[oauth] sayfa keşfi başarısız: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
    }
  }

  // 7) Reklam hesabı keşfi. Mock modda gerçek Graph çağrısı atlanır (token gerçek olsa bile).
  let adAccounts = 0;
  if (!env.META_MOCK_MODE) {
    try {
      const discovered = await createMetaClient({ mock: false }).getAdAccounts(accessToken);
      adAccounts = await syncDiscoveredAdAccounts(actor, connectionId, discovered);
    } catch (err) {
      logger.warn(`[oauth] reklam hesabı keşfi başarısız: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
    }
  }

  await logAudit({
    actor,
    action: "META_CONNECTED",
    entityType: "META_CONNECTION",
    entityId: connectionId,
    after: {
      type: "BUSINESS_MANAGER",
      metaUserId,
      missingPermissions,
      optionalMissing,
      pages,
      adAccounts,
      longLived,
    },
  });
  return { missing: missingPermissions, optionalMissing, pages, adAccounts };
}

function ttlToDate(expiresIn: unknown): Date | null {
  return typeof expiresIn === "number" && expiresIn > 0
    ? new Date(Date.now() + expiresIn * 1000)
    : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

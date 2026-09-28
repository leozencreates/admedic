import { prisma, type MetaConnectionStatus } from "@admedic/database";
import { loadEnv } from "@admedic/config";
import {
  exchangeUserToken,
  getAppAccessToken,
  getGraphVersion,
  getTokenDebug,
  graphAuth,
  MetaGraphError,
  nextPageUrl,
  rawGraph,
  type MetaAccount,
} from "@admedic/meta-api";
import { HttpError } from "./http";
import { decrypt, encrypt } from "./encrypt";
import { requiredScopesMissing } from "./meta-scopes";

/**
 * Süresi dolmadan önce token'ı yenilemeye çalışmak için eşik.
 * Meta belgelerinde uzun ömürlü token ~60 gün geçerlidir; eşik altında kalan
 * bağlantılar otomatik yenilenmeye aday kabul edilir.
 */
export const META_REFRESH_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
/** Mock modda "yenilenen" token için varsayılan ömür (~60 gün, Meta uzun ömürlü token). */
const MOCK_TOKEN_TTL_MS = 60 * 24 * 60 * 60 * 1000;

export interface LiveMetaConnectionResult {
  connectionId: string;
  token: string;
  mockMode: boolean;
  expiresAt: Date | null;
}

/**
 * Bağlantıyı kopmuş olarak kalıcılaştırır: durum + `lastError` yazılır ve bağlı
 * reklam hesapları PAUSED'a alınır (DELETE ile aynı davranış; spec 3.1 "bağlantı
 * kesilince kampanya işlemleri durur"). Aynı bağlantı için tekrar çağrılması güvenlidir.
 */
export async function markConnectionBroken(
  connId: string,
  status: Extract<MetaConnectionStatus, "EXPIRED" | "REVOKED">,
  lastError: string,
  opts: { clearToken?: boolean } = {},
): Promise<{ adAccountsPaused: number }> {
  const [, paused] = await prisma.$transaction([
    prisma.metaConnection.update({
      where: { id: connId },
      data: {
        status,
        lastError,
        ...(opts.clearToken ? { tokenCiphertext: null } : {}),
      },
    }),
    prisma.adAccount.updateMany({
      where: { connectionId: connId, status: "ACTIVE" },
      data: { status: "PAUSED" },
    }),
  ]);
  return { adAccountsPaused: paused.count };
}

/**
 * Meta çağrısı yapmadan önce bağlantıyı doğrular: durum, token varlığı ve
 * süre. Süresi dolmuş token bağlantıyı EXPIRED olarak kalıcılaştırır; süre
 * eşiğin altında ise sessizce yenilemeyi dener (başarısızlığı yut; asıl çağrı
 * yine de gider). spec 3.1: "Token süresi dolmadan yenileme".
 */
export async function requireLiveMetaConnection(
  connId: string,
  orgId: string,
): Promise<LiveMetaConnectionResult> {
  const conn = await prisma.metaConnection.findUnique({ where: { id: connId } });
  if (!conn || conn.orgId !== orgId)
    throw new HttpError(400, "Meta bağlantısı bulunamadı. Meta bağlantıları sayfasını yenileyin; bağlantı yoksa Meta ile bağlantı kurun.");
  if (conn.status !== "CONNECTED")
    throw new HttpError(
      conn.status === "EXPIRED"
        ? 400
        : conn.status === "REVOKED"
          ? 401
          : 400,
      "Meta bağlantısı aktif değil. Bağlantı sayfasından yenileyin.",
    );
  const env = loadEnv();
  if (env.META_MOCK_MODE)
    return {
      connectionId: conn.id,
      token: "mock-token",
      mockMode: true,
      expiresAt: conn.expiresAt,
    };
  if (!conn.tokenCiphertext)
    throw new HttpError(400, "Meta erişim anahtarı bulunamadı. Meta bağlantıları sayfasından Meta ile yeniden bağlanın.");
  if (conn.expiresAt && conn.expiresAt.getTime() <= Date.now()) {
    await markConnectionBroken(conn.id, "EXPIRED", "Token süresi doldu.");
    throw new HttpError(
      400,
      "Meta erişim anahtarının süresi doldu. Meta bağlantıları sayfasından yeniden bağlanın.",
    );
  }
  let current = conn;
  if (conn.expiresAt && conn.expiresAt.getTime() - Date.now() < META_REFRESH_WINDOW_MS) {
    try {
      await refreshMetaConnection(conn.id);
    } catch {
      // Best-effort: yenileme başarısız olsa da çağrı devam eder (durum DB'ye yazıldı).
    }
    current = await prisma.metaConnection.findUniqueOrThrow({ where: { id: conn.id } });
    if (current.status !== "CONNECTED" || !current.tokenCiphertext)
      throw new HttpError(
        current.status === "REVOKED" ? 401 : 400,
        "Meta bağlantısı aktif değil. Bağlantı sayfasından yeniden bağlanın.",
      );
  }
  return {
    connectionId: current.id,
    token: decrypt(current.tokenCiphertext ?? ""),
    mockMode: false,
    expiresAt: current.expiresAt,
  };
}

export interface RefreshMetaResult {
  refreshed: boolean;
  status: string;
  expiresAt: Date | null;
  missingPermissions: string[];
}

/**
 * Meta token'ını yeniler: debug_token ile durumu doğrular, ardından
 * `fb_exchange_token` ile yeni uzun ömürlü token üretir (belgelenmiş kural:
 * yalnızca süresi dolmamış token yenilenebilir). Başarısızlık durumları DB'ye
 * kalıcılaştırılır: süresi dolmuş → EXPIRED, geçersiz/iptal → REVOKED (+lastError).
 * Mock modda REVOKED (kullanıcı açıkça kesti) bağlantı yeniden CONNECTED yapılmaz.
 */
export async function refreshMetaConnection(connId: string): Promise<RefreshMetaResult> {
  const env = loadEnv();
  if (!env.META_APP_ID || !env.META_APP_SECRET)
    throw new HttpError(400, "Meta uygulama ayarları eksik (META_APP_ID/META_APP_SECRET); bağlantı yenilenemiyor. Sistem yöneticinize bildirin.");
  const conn = await prisma.metaConnection.findUnique({ where: { id: connId } });
  if (!conn) throw new HttpError(404, "Meta bağlantısı bulunamadı. Meta bağlantıları sayfasını yenileyin; bağlantı yoksa Meta ile bağlantı kurun.");
  if (conn.status === "REVOKED")
    throw new HttpError(
      409,
      "Bağlantı kesilmiş veya iptal edilmiş; “Meta ile bağlantı kur” düğmesiyle yeniden bağlanın.",
    );
  if (env.META_MOCK_MODE) {
    const mock = await prisma.metaConnection.update({
      where: { id: connId },
      data: {
        status: "CONNECTED",
        lastError: null,
        expiresAt: new Date(Date.now() + MOCK_TOKEN_TTL_MS),
      },
    });
    return {
      refreshed: true,
      status: mock.status,
      expiresAt: mock.expiresAt,
      missingPermissions: mock.missingPermissions,
    };
  }
  if (!conn.tokenCiphertext)
    throw new HttpError(400, "Kayıtlı Meta erişim anahtarı bulunamadı. Meta ile yeniden bağlanın.");
  if (conn.expiresAt && conn.expiresAt.getTime() <= Date.now()) {
    await markConnectionBroken(conn.id, "EXPIRED", "Token süresi doldu.");
    throw new HttpError(
      409,
      "Süresi dolmuş Meta erişim anahtarı yenilenemez (Meta kuralı). Meta ile yeniden bağlanın.",
    );
  }

  const currentToken = decrypt(conn.tokenCiphertext);
  const debug = await getTokenDebug(currentToken, getAppAccessToken());
  if (debug.isValid === false) {
    const reason = debug.error
      ? `Meta token'ı geçersiz: ${debug.error}`
      : "Meta token'ı geçersiz veya iptal edilmiş.";
    await markConnectionBroken(conn.id, "REVOKED", reason);
    throw new HttpError(409, reason);
  }

  let exchanged;
  try {
    exchanged = await exchangeUserToken(currentToken);
  } catch (err) {
    // 190 = geçersiz/iptal edilmiş OAuth token → REVOKED; diğer hatalar yalnızca lastError.
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof MetaGraphError && err.detail.code === 190) {
      await markConnectionBroken(conn.id, "REVOKED", `Meta token'ı geçersiz: ${message}`);
    } else {
      await prisma.metaConnection.update({
        where: { id: conn.id },
        data: { lastError: `Token yenileme başarısız: ${message}`.slice(0, 500) },
      });
    }
    throw err;
  }
  const missingPermissions = requiredScopesMissing(
    debug.scopes.length > 0 ? debug.scopes : conn.scopes,
  );
  const nextExpiresAt =
    exchanged.expiresAt ??
    (debug.expiresAt ? (debug.expiresAt.getTime() > Date.now() ? debug.expiresAt : null) : null);

  const data = {
    tokenCiphertext: encrypt(exchanged.accessToken),
    expiresAt: nextExpiresAt,
    scopes: debug.scopes.length > 0 ? debug.scopes : conn.scopes,
    missingPermissions,
    status: "CONNECTED" as const,
    lastError: null as string | null,
  };
  const updated = await prisma.metaConnection.update({ where: { id: conn.id }, data });
  return {
    refreshed: true,
    status: updated.status,
    expiresAt: updated.expiresAt,
    missingPermissions,
  };
}

// ------------------------------------------------------------------------------------
// Bağlantı kurulumu: Graph keşfi (reklam hesapları, sayfalar) — OAuth callback ve
// platforms/connect tarafından paylaşılır.
// ------------------------------------------------------------------------------------

/**
 * Yetkili Graph GET: token `Authorization: Bearer` başlığında, `appsecret_proof`
 * (META_APP_SECRET varsa) sorgu parametresinde. Hatalar `MetaGraphError` olarak yükselir.
 */
export async function graphGetAuthed(
  path: string,
  params: Record<string, string>,
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<unknown> {
  const env = loadEnv();
  const auth = graphAuth(token, env.META_APP_SECRET);
  // Sürüm ortamdan çözülür (META_GRAPH_API_VERSION ?? META_API_VERSION); ayarsızsa açık hata.
  const url = new URL(`https://graph.facebook.com/${getGraphVersion()}/${path.replace(/^\//, "")}`);
  for (const [k, v] of Object.entries({ ...params, ...auth.params })) {
    if (v !== undefined && v !== "") url.searchParams.set(k, v);
  }
  const res = await rawGraph(url.toString(), fetchFn, { method: "GET", headers: auth.headers });
  return res.body;
}

export interface DiscoveredPage {
  id: string;
  name: string;
  /** Sayfa erişim token'ı (uzun ömürlü kullanıcı token'ı ile alınırsa süresizdir). */
  accessToken: string | null;
  /** Sayfaya bağlı Instagram profesyonel hesabı (instagram_basic izni gerekir). */
  instagramBusinessAccountId: string | null;
}

/** Mock modda deterministik sahte sayfa (Graph çağrısı yok). */
export function mockDiscoveredPages(): DiscoveredPage[] {
  return [
    {
      id: "page_mock_1",
      name: "Mock Klinik Sayfası",
      accessToken: "mock-page-token",
      instagramBusinessAccountId: "ig_mock_1",
    },
  ];
}

/** Mock moddaki yayın sayfası (mockDiscoveredPages ile aynı). */
export const MOCK_PAGE_ID = "page_mock_1";
const MOCK_PAGE_TOKEN = "mock-page-token";

export interface PublishPage {
  pageId: string;
  /** Yalnızca istenirse (Instant Form) çözülür. */
  pageToken: string | null;
}

/**
 * Reklamların yayınlanacağı Facebook Sayfası (kreatif `object_story_spec.page_id`, lead reklamı ve
 * WhatsApp için ad set `promoted_object.page_id`). Öncelik: reklam hesabı bağlantısında elle girilen
 * Sayfa ID → kuruluşun tek bağlı (CONNECTED) PAGE bağlantısı. Birden fazla sayfa varsa seçim zorunludur.
 * Instant Form için sayfa erişim token'ı gerekir (leadgen_forms; pages_manage_ads izni).
 */
export async function resolvePublishPage(input: {
  orgId: string;
  connectionId: string | null;
  mockMode: boolean;
  needPageToken: boolean;
}): Promise<PublishPage> {
  const adConnection = input.connectionId
    ? await prisma.metaConnection.findFirst({
        where: { id: input.connectionId, orgId: input.orgId },
        select: { pageId: true },
      })
    : null;
  const pages = await prisma.metaConnection.findMany({
    where: { orgId: input.orgId, type: "PAGE", status: "CONNECTED", pageId: { not: null } },
    select: { pageId: true, tokenCiphertext: true, scopes: true },
    orderBy: { createdAt: "asc" },
  });
  let pageId = adConnection?.pageId?.trim() || null;
  if (!pageId) {
    if (pages.length > 1)
      throw new HttpError(
        422,
        "Birden fazla Facebook Sayfası bağlı. Meta bağlantıları sayfasında “Kimlik numaralarını düzenle” ile reklamların yayınlanacağı Facebook Sayfası kimliğini girin.",
      );
    pageId = pages[0]?.pageId ?? null;
  }
  if (!pageId) {
    if (input.mockMode)
      return { pageId: MOCK_PAGE_ID, pageToken: input.needPageToken ? MOCK_PAGE_TOKEN : null };
    throw new HttpError(
      422,
      "Reklamların yayınlanacağı Facebook Sayfası bulunamadı. Meta ile yeniden bağlanın ya da Meta bağlantıları sayfasında Facebook Sayfası kimliğini girin.",
    );
  }
  if (!input.needPageToken) return { pageId, pageToken: null };
  if (input.mockMode) return { pageId, pageToken: MOCK_PAGE_TOKEN };
  const page = pages.find((p) => p.pageId === pageId);
  if (!page?.tokenCiphertext)
    throw new HttpError(
      422,
      "Anında Form için sayfa erişim anahtarı bulunamadı. Meta bağlantıları sayfasından Meta ile yeniden bağlanın.",
    );
  if (page.scopes.length > 0 && !page.scopes.includes("pages_manage_ads"))
    throw new HttpError(
      422,
      "Anında Form oluşturmak için Meta'da pages_manage_ads izni gerekli; Meta ile yeniden bağlanıp bu izni verin.",
    );
  return { pageId, pageToken: decrypt(page.tokenCiphertext) };
}

/**
 * `GET /me/accounts?fields=id,name,access_token,instagram_business_account` —
 * kullanıcının rolü olduğu sayfalar + sayfa token'ları (pages_show_list) ve bağlı
 * Instagram hesabı (instagram_basic). Sayfalama en fazla 5 sayfa izlenir.
 * Kaynak: developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived
 * ("long-lived Page access token") — bkz. docs/meta-constraints.md (2026-09-26).
 */
export async function fetchPageAccounts(
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<DiscoveredPage[]> {
  const pages: DiscoveredPage[] = [];
  let body = await graphGetAuthed(
    "me/accounts",
    { fields: "id,name,access_token,instagram_business_account", limit: "50" },
    token,
    fetchFn,
  );
  for (let page = 0; page < 5; page++) {
    const rows = isRecord(body) && Array.isArray(body.data) ? body.data : [];
    for (const row of rows) {
      if (!isRecord(row) || row.id === undefined) continue;
      const ig = isRecord(row.instagram_business_account) ? row.instagram_business_account : null;
      pages.push({
        id: String(row.id),
        name: typeof row.name === "string" && row.name !== "" ? row.name : "Meta Sayfası",
        accessToken: typeof row.access_token === "string" && row.access_token !== "" ? row.access_token : null,
        instagramBusinessAccountId: ig && ig.id !== undefined ? String(ig.id) : null,
      });
    }
    const paging = isRecord(body) && isRecord(body.paging) ? body.paging : {};
    const auth = graphAuth(token, loadEnv().META_APP_SECRET);
    // Yalnızca Graph kökündeki bağlantı izlenir; `appsecret_proof` bağlantıda yoksa taşınır.
    const next = nextPageUrl(paging.next, auth.params);
    if (!next) break;
    body = (await rawGraph(next, fetchFn, { method: "GET", headers: auth.headers })).body;
  }
  return pages;
}

export interface PageConnectionMeta {
  metaUserId: string | null;
  appId: string | null;
  scopes: string[];
  /** Sayfa token'ının son kullanma tarihi (uzun ömürlü kullanıcı token'ından türetildiyse null). */
  expiresAt: Date | null;
}

/**
 * Keşfedilen sayfaları PAGE tipi MetaConnection kayıtları olarak yazar
 * (`pageId` ile eşleşen kayıt güncellenir; sayfa token'ı şifreli saklanır).
 */
export async function syncPageConnections(
  orgId: string,
  pages: DiscoveredPage[],
  meta: PageConnectionMeta,
): Promise<{ created: number; updated: number; pageIds: string[] }> {
  let created = 0;
  let updated = 0;
  const pageIds: string[] = [];
  for (const page of pages) {
    const data = {
      status: "CONNECTED" as const,
      name: page.name,
      pageId: page.id,
      instaId: page.instagramBusinessAccountId,
      tokenCiphertext: page.accessToken ? encrypt(page.accessToken) : null,
      metaUserId: meta.metaUserId,
      appId: meta.appId,
      scopes: meta.scopes,
      expiresAt: meta.expiresAt,
      lastError: null as string | null,
    };
    const existing = await prisma.metaConnection.findFirst({
      where: { orgId, type: "PAGE", pageId: page.id },
      select: { id: true },
    });
    if (existing) {
      await prisma.metaConnection.update({ where: { id: existing.id }, data });
      updated++;
    } else {
      await prisma.metaConnection.create({ data: { orgId, type: "PAGE", ...data } });
      created++;
    }
    pageIds.push(page.id);
  }
  return { created, updated, pageIds };
}

/**
 * Keşfedilen reklam hesaplarını AdAccount olarak yazar. Workspace'te varsayılan
 * hesap yoksa ilk oluşturulan varsayılan olur; bayrak döngü içinde güncellenir
 * (birden fazla hesabın varsayılan işaretlenmesi hatası giderildi).
 */
export async function syncDiscoveredAdAccounts(
  scope: { orgId: string; workspaceId: string },
  connectionId: string,
  discovered: MetaAccount[],
): Promise<number> {
  let hasDefault = Boolean(
    await prisma.adAccount.findFirst({
      where: { workspaceId: scope.workspaceId, isDefault: true },
      select: { id: true },
    }),
  );
  let count = 0;
  for (const acc of discovered) {
    const row = await prisma.adAccount.upsert({
      where: { orgId_metaAccountId: { orgId: scope.orgId, metaAccountId: acc.id } },
      create: {
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
        connectionId,
        metaAccountId: acc.id,
        name: acc.name !== "" ? acc.name : "Meta Reklam Hesabı",
        currency: acc.currency ?? "EUR",
        timezone: acc.timezone ?? "Europe/Istanbul",
        status: "ACTIVE",
        isDefault: !hasDefault,
        syncedAt: new Date(),
      },
      update: {
        connectionId,
        name: acc.name !== "" ? acc.name : undefined,
        currency: acc.currency ?? undefined,
        timezone: acc.timezone ?? undefined,
        status: "ACTIVE",
        syncedAt: new Date(),
      },
      select: { isDefault: true },
    });
    if (row.isDefault) hasDefault = true;
    count++;
  }
  return count;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

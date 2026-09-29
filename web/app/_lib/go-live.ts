/**
 * Canlıya geçiş denetimi (ADR-0023). Üç bölüm:
 * 1. Sunucu yapılandırması — ortam değişkenlerinin varlığı ve biçimi; değerlerin kendisi hiçbir zaman döndürülmez.
 * 2. Meta bağlantısı (canlı, salt okunur) — token geçerliliği, izinler, reklam hesapları, sayfa/piksel/WhatsApp
 *    eşlemesi. Meta'ya hiçbir şey yazılmaz.
 * 3. Uçtan uca kanıtlar — gerçek hesapta gerçekleşmiş olaylar (kapalı yayın, webhook ile gelen lead, WhatsApp
 *    mesajı). Deneme (mock) modunda bu kanıtlar sayılmaz.
 * Sunucu modülüdür; yalnızca hesap sahibi çağırır (API ucu denetler).
 */
import { prisma } from "@admedic/database";
import { getAppAccessToken, getTokenDebug, createMetaClient, MetaGraphError } from "@admedic/meta-api";
import { getLlmConfig, loadEnv } from "@admedic/config";
import { decrypt } from "./encrypt";
import { requiredScopesMissing, scopeLabel } from "./meta-scopes";
import { readPageSubscription } from "./meta-connection";
import { deliveryBacklog } from "./webhook-queue";

export type CheckStatus = "ok" | "warn" | "fail";

export interface Check {
  key: string;
  label: string;
  status: CheckStatus;
  /** Ne görüldü ve ne yapılmalı; gizli değer içermez. */
  detail: string;
}

const ok = (key: string, label: string, detail: string): Check => ({ key, label, status: "ok", detail });
const warn = (key: string, label: string, detail: string): Check => ({ key, label, status: "warn", detail });
const fail = (key: string, label: string, detail: string): Check => ({ key, label, status: "fail", detail });

/** 1) Sunucu yapılandırması. */
export async function configChecks(): Promise<Check[]> {
  const env = loadEnv();
  const checks: Check[] = [];
  checks.push(
    env.META_MOCK_MODE
      ? fail("mode", "Çalışma modu", "Deneme modu açık: Meta'ya bağlanılmaz, sahte veri üretilir. Canlı için META_MOCK_MODE=false.")
      : ok("mode", "Çalışma modu", "Canlı: Meta'ya gerçek istekler gider."),
  );
  checks.push(
    /^https:\/\//i.test(env.AUTH_URL)
      ? ok("url", "Panel adresi", "HTTPS ile yayında.")
      : fail("url", "Panel adresi", "AUTH_URL https:// ile başlamalı (Meta dönüş adresi ve güvenli oturum çerezi için)."),
  );
  let redirectHost: string | null = null;
  let panelHost: string | null = null;
  try {
    redirectHost = new URL(env.META_REDIRECT_URI).host;
    panelHost = new URL(env.AUTH_URL).host;
  } catch {
    // aşağıda uyarı olur
  }
  checks.push(
    redirectHost && redirectHost === panelHost && env.META_REDIRECT_URI.endsWith("/api/meta/oauth/callback")
      ? ok("redirect", "Meta dönüş adresi", "Panel adresiyle aynı alan adında.")
      : fail("redirect", "Meta dönüş adresi", "META_REDIRECT_URI, panel adresi + /api/meta/oauth/callback olmalı ve Meta uygulamasında aynen kayıtlı olmalı."),
  );
  checks.push(
    env.META_APP_ID && env.META_APP_SECRET
      ? ok("app", "Meta uygulaması", "Uygulama kimliği ve gizli anahtarı ayarlı.")
      : fail("app", "Meta uygulaması", "META_APP_ID ve META_APP_SECRET ayarlanmalı."),
  );
  checks.push(
    env.metaGraphApiVersion
      ? ok("version", "Graph API sürümü", `Sürüm ${env.metaGraphApiVersion}.`)
      : fail("version", "Graph API sürümü", "META_API_VERSION ayarlanmalı (ör. v26.0)."),
  );
  checks.push(
    env.META_WEBHOOK_VERIFY_TOKEN
      ? ok("webhook-token", "Webhook doğrulama belirteci", "Ayarlı; Meta uygulamasındaki webhook ayarına aynı değer girilmeli.")
      : fail("webhook-token", "Webhook doğrulama belirteci", "META_WEBHOOK_VERIFY_TOKEN ayarlanmalı; Meta webhook aboneliği bu değerle doğrulanır."),
  );
  checks.push(
    env.ENCRYPTION_KEY
      ? ok("encryption", "Şifreleme anahtarı", "Ayarlı. Yedekten ayrı ve güvenli bir yerde saklayın.")
      : fail("encryption", "Şifreleme anahtarı", "ENCRYPTION_KEY ayarlanmalı (kişisel veri ve token şifrelemesi)."),
  );
  checks.push(
    getLlmConfig()
      ? ok("llm", "Yapay zekâ", "Anahtar ve model ayarlı; asistan ve metin üretimi çalışır.")
      : warn("llm", "Yapay zekâ", "ANTHROPIC_API_KEY ve LLM_MODEL ayarlı değil: asistan kısa hazır metinle karşılar, metin üretimi kapalı."),
  );
  const backlog = await deliveryBacklog();
  checks.push(
    backlog.failed > 0
      ? fail("webhooks", "Webhook kuyruğu", `${backlog.failed} teslim kalıcı olarak işlenemedi; sunucu günlüğüne bakın.`)
      : backlog.pending > 0
        ? warn("webhooks", "Webhook kuyruğu", `${backlog.pending} teslim yeniden denenmeyi bekliyor.`)
        : ok("webhooks", "Webhook kuyruğu", "Bekleyen ya da başarısız teslim yok."),
  );
  return checks;
}

export interface ConnectionReport {
  id: string;
  name: string;
  type: string;
  checks: Check[];
}

function metaError(error: unknown): string {
  if (error instanceof MetaGraphError) return `Meta hatası (kod ${error.detail.code ?? "-"}): ${error.message.slice(0, 160)}`;
  return error instanceof Error ? error.message.slice(0, 160) : "Bilinmeyen hata";
}

/**
 * 2) Meta bağlantıları: kuruluşun her etkin bağlantısı için canlı, salt okunur denetim. Deneme modunda
 * Meta'ya gidilmez.
 */
export async function metaChecks(orgId: string, now = new Date()): Promise<{ live: boolean; connections: ConnectionReport[] }> {
  const env = loadEnv();
  const connections = await prisma.metaConnection.findMany({
    where: { orgId, status: { not: "REVOKED" } },
    orderBy: { createdAt: "asc" },
    select: {
      id: true, name: true, type: true, status: true, tokenCiphertext: true, scopes: true, pageId: true,
      pixelId: true, whatsappPhoneNumberId: true, expiresAt: true,
    },
  });
  if (env.META_MOCK_MODE) return { live: false, connections: [] };
  const appToken = env.META_APP_ID && env.META_APP_SECRET ? getAppAccessToken() : null;
  const meta = createMetaClient();
  const reports: ConnectionReport[] = [];
  for (const conn of connections) {
    const checks: Check[] = [];
    let token: string | null = null;
    try {
      token = conn.tokenCiphertext ? decrypt(conn.tokenCiphertext) : null;
    } catch {
      checks.push(fail("token", "Erişim anahtarı", "Kayıtlı anahtar çözülemedi (ENCRYPTION_KEY değişmiş olabilir); Meta ile yeniden bağlanın."));
    }
    if (!token && checks.length === 0) checks.push(fail("token", "Erişim anahtarı", "Kayıtlı anahtar yok; Meta ile yeniden bağlanın."));
    if (token && appToken) {
      try {
        const debug = await getTokenDebug(token, appToken);
        if (!debug.isValid) checks.push(fail("token", "Erişim anahtarı", `Geçersiz${debug.error ? `: ${debug.error.slice(0, 120)}` : ""}. Meta ile yeniden bağlanın.`));
        else {
          const days = debug.expiresAt ? Math.floor((debug.expiresAt.getTime() - now.getTime()) / 86_400_000) : null;
          checks.push(
            days !== null && days < 7
              ? warn("token", "Erişim anahtarı", `Geçerli, ${days} gün içinde sona eriyor; bağlantıyı yenileyin.`)
              : ok("token", "Erişim anahtarı", days === null ? "Geçerli (süresiz)." : `Geçerli, ${days} gün daha.`),
          );
          const missing = requiredScopesMissing(debug.scopes);
          checks.push(
            missing.length
              ? fail("scopes", "İzinler", `Eksik: ${missing.map(scopeLabel).join(", ")}. App Review onayı ve yeniden bağlanma gerekir.`)
              : ok("scopes", "İzinler", "Zorunlu izinlerin hepsi verilmiş."),
          );
        }
      } catch (error) {
        checks.push(fail("token", "Erişim anahtarı", metaError(error)));
      }
    } else if (token && !appToken) {
      checks.push(fail("token", "Erişim anahtarı", "Denetlenemedi: META_APP_ID ve META_APP_SECRET ayarlı değil."));
    }
    if (token && (conn.type === "AD_ACCOUNT" || conn.type === "BUSINESS_MANAGER")) {
      try {
        const accounts = await meta.getAdAccounts(token);
        checks.push(
          accounts.length
            ? ok("accounts", "Reklam hesapları", `${accounts.length} reklam hesabı okunabiliyor.`)
            : fail("accounts", "Reklam hesapları", "Bu bağlantıyla okunabilen reklam hesabı yok."),
        );
      } catch (error) {
        checks.push(fail("accounts", "Reklam hesapları", metaError(error)));
      }
    }
    if (token && conn.type === "PAGE" && conn.pageId) {
      try {
        const fields = await readPageSubscription(conn.pageId, token);
        checks.push(
          fields.includes("leadgen")
            ? ok("subscription", "Lead bildirimi aboneliği", `Sayfa uygulamaya abone (${fields.join(", ")}).`)
            : fail("subscription", "Lead bildirimi aboneliği", "Sayfa uygulamaya abone değil; lead bildirimi gelmez. Meta ile yeniden bağlanın (abonelik bağlanırken yapılır)."),
        );
      } catch (error) {
        checks.push(fail("subscription", "Lead bildirimi aboneliği", metaError(error)));
      }
    }
    checks.push(
      conn.pageId
        ? ok("page", "Facebook sayfası", "Yayın sayfası eşlenmiş.")
        : warn("page", "Facebook sayfası", "Sayfa kimliği yok; Anında Form ve reklam yayını için gerekir (Meta bağlantıları sayfası)."),
    );
    checks.push(
      conn.pixelId
        ? ok("pixel", "Piksel", "Dönüşüm bildirimi için piksel eşlenmiş.")
        : warn("pixel", "Piksel", "Piksel kimliği yok; Meta'ya dönüşüm bildirimi (CAPI) gönderilmez."),
    );
    checks.push(
      conn.whatsappPhoneNumberId
        ? ok("whatsapp", "WhatsApp numarası", "WhatsApp numarası eşlenmiş.")
        : warn("whatsapp", "WhatsApp numarası", "Eşlenmemiş; WhatsApp mesajları bu kuruluşa yönlendirilmez."),
    );
    reports.push({ id: conn.id, name: conn.name ?? "Adsız bağlantı", type: conn.type, checks });
  }
  return { live: true, connections: reports };
}

/** 3) Uçtan uca kanıtlar: gerçek hesapta gerçekleşmiş olaylar (deneme modunda sayılmaz). */
export async function endToEndChecks(orgId: string): Promise<{ live: boolean; checks: Check[] }> {
  const env = loadEnv();
  if (env.META_MOCK_MODE) return { live: false, checks: [] };
  const [connected, published, adLead, waIn, waOut] = await Promise.all([
    prisma.metaConnection.count({ where: { orgId, status: "CONNECTED", missingPermissions: { isEmpty: true } } }),
    prisma.campaign.count({
      where: { workspace: { orgId }, metaCampaignId: { not: null }, workflowStatus: { in: ["PUBLISHED_PAUSED", "ACTIVE"] } },
    }),
    prisma.lead.count({ where: { organizationId: orgId, leadgenId: { not: null } } }),
    prisma.message.count({
      where: { conversation: { lead: { organizationId: orgId } }, channel: "WHATSAPP", direction: "INCOMING", externalId: { not: null } },
    }),
    prisma.message.count({
      where: {
        conversation: { lead: { organizationId: orgId } },
        channel: "WHATSAPP",
        direction: "OUTGOING",
        OR: [{ sender: null }, { sender: { not: "system" } }],
      },
    }),
  ]);
  const step = (key: string, label: string, done: boolean, todo: string) =>
    done ? ok(key, label, "Gerçekleşti.") : warn(key, label, todo);
  return {
    live: true,
    checks: [
      step("connect", "Meta bağlantısı eksiksiz", connected > 0, "Meta bağlantıları sayfasından bağlanın; zorunlu izinlerin hepsi verilmeli."),
      step("publish", "Kapalı yayın (harcama yok)", published > 0, "Bir kampanyayı onaylayıp Meta'ya kapalı yükleyin; etkinleştirmeyin."),
      step("lead", "Anında Form lead'i webhook ile geldi", adLead > 0, "Meta Lead Ads test aracıyla bir test lead'i gönderin."),
      step("wa-in", "WhatsApp mesajı alındı", waIn > 0, "İşletme numarasına bir test mesajı yazın."),
      step("wa-out", "WhatsApp yanıtı gönderildi", waOut > 0, "Gelen mesaja asistanın ya da ekibin yanıt verdiğini doğrulayın."),
    ],
  };
}

// ADR-0025: kabuk yalnızca kullanıcının girdiği sunucudaki web panelini açar.
// Bu dosya saf işlevler içerir (DOM yok); `scripts/server-url.test.mjs` ile sınanır.

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Kullanıcının yazdığı adresi panelin origin'ine çevirir.
 * - Şema yazılmamışsa yerel adrese `http://`, diğerlerine `https://` eklenir.
 * - `http://` yalnızca bu bilgisayardaki sunucu (geliştirme) için kabul edilir; uzak sunucu HTTPS olmalıdır.
 * - Yol, sorgu ve parça atılır; kullanıcı adı/parola içeren adres reddedilir.
 * @returns {{ ok: true, origin: string } | { ok: false, reason: "empty" | "invalid" | "insecure" }}
 */
export function normalizeServerUrl(input) {
  const raw = String(input ?? "").trim();
  if (raw === "") return { ok: false, reason: "empty" };

  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  let url;
  try {
    url = new URL(hasScheme ? raw : `https://${raw}`);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  const local = LOCAL_HOSTS.has(url.hostname);
  if (!hasScheme && local) url.protocol = "http:";

  if (url.username !== "" || url.password !== "") return { ok: false, reason: "invalid" };
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, reason: "invalid" };
  if (url.protocol === "http:" && !local) return { ok: false, reason: "insecure" };
  return { ok: true, origin: url.origin };
}

/**
 * `GET /api/health` yanıtını yorumlar (web/app/api/health/route.ts).
 * `ok` ve `degraded` panelin açılabildiği durumlardır; `down` veritabanına ulaşılamadığını söyler.
 * @returns {"up" | "down" | "unknown"}
 */
export function readHealth(body) {
  const status = body && typeof body === "object" ? body.status : undefined;
  if (status === "ok" || status === "degraded") return "up";
  if (status === "down") return "down";
  return "unknown";
}

import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { loadEnv } from "@admedic/config";

import { allowedOrigins, authorizeApiRequest } from "./lib";
import { registerRoutes } from "./routes";

export interface BuildAppOptions {
  logger?: boolean;
}

/** pino redaksiyonu: belirteç, çerez ve kişisel veri (e-posta/telefon) loglara yazılmaz (spec 3.11). */
export const LOG_REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["set-cookie"]',
  'res.headers["set-cookie"]',
  "authorization",
  "cookie",
  "token",
  "email",
  "phone",
  "*.authorization",
  "*.cookie",
  "*.token",
  "*.email",
  "*.phone",
];

let warnedTokenless = false;

/**
 * Yetki denetimi router'ın çözdüğü yola bakmalıdır, ham `request.url`'e değil:
 * find-my-way yolu yüzde-kodunu çözer (`/%76%31/alerts` -> `/v1/alerts`), ham URL'de ise
 * denetim atlanır ve aynı uç belirteçsiz çağrılabilir.
 */
function guardedPath(request: { routeOptions?: { url?: string }; url: string }): string {
  if (typeof request.routeOptions?.url === "string") return request.routeOptions.url;
  const raw = request.url.split("?")[0] ?? "/";
  try {
    return decodeURI(raw);
  } catch {
    return raw;
  }
}

/**
 * ADR-0001/0003: Fastify v5, salt okunur REST; tüm iş mantığı paketlerde (database/shared), API yalnızca taşır.
 * - CORS yalnızca panel (`AUTH_URL`) ve Tauri kaynakları.
 * - `/v1/*` uçları `API_TOKEN` Bearer belirteci ister; belirteç yoksa mock modda açık, aksi halde 503.
 * - `/` ve `/health` belirteçsizdir (canlılık; veri taşımaz).
 */
export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const env = loadEnv();
  const loggerEnabled = opts.logger ?? env.NODE_ENV !== "test";
  const app = Fastify({
    logger: loggerEnabled
      ? { level: env.LOG_LEVEL, redact: { paths: LOG_REDACT_PATHS, censor: "[redacted]" } }
      : false,
  });
  await app.register(cors, { origin: allowedOrigins(env), methods: ["GET", "HEAD", "OPTIONS"] });

  app.addHook("onRequest", async (request, reply) => {
    if (request.method === "OPTIONS" || !guardedPath(request).startsWith("/v1/")) return;
    // Ortam her istekte okunur (önbellekli); testler `loadEnv({ fresh: true })` ile değiştirebilir.
    const current = loadEnv();
    const decision = authorizeApiRequest(request.headers.authorization, current);
    if (!decision.ok) {
      if (decision.status === 401) reply.header("www-authenticate", 'Bearer realm="api"');
      await reply.code(decision.status).send({ error: decision.message });
      return reply;
    }
    if (!current.API_TOKEN && !warnedTokenless) {
      warnedTokenless = true;
      request.log.warn("API_TOKEN ayarlı değil; mock modda belirteçsiz erişime izin veriliyor.");
    }
  });

  await registerRoutes(app);
  return app;
}

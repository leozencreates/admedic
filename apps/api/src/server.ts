import { loadEnv } from "@admedic/config";

import { buildApp } from "./app";
import { serviceName } from "./lib";

/**
 * `PORT` ve `API_HOST` EnvSchema'da yoktur; doğrudan süreç ortamından okunur
 * (varsayılan 127.0.0.1:3001 — masaüstü kabuğu ve `API_URL` varsayılanıyla aynı).
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const app = await buildApp();
  const port = Number(process.env.PORT ?? 3001);
  const host = process.env.API_HOST ?? "127.0.0.1";
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`Geçersiz PORT: ${process.env.PORT}`);
  await app.listen({ port, host });
  app.log.info(`${serviceName(env)} dinliyor → http://${host}:${port}`);
}

void main().catch((err) => {
  console.error("API başlatılamadı:", err);
  process.exit(1);
});

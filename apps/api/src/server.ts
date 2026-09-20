import { buildApp } from "./app";

async function main(): Promise<void> {
  const app = await buildApp();
  const port = Number(process.env.PORT ?? 3001);
  const host = process.env.API_HOST ?? "0.0.0.0";
  await app.listen({ port, host });
  app.log.info(`admedic-api dinliyor → http://localhost:${port}`);
}

void main().catch((err) => {
  console.error("admedic-api başlatılamadı:", err);
  process.exit(1);
});

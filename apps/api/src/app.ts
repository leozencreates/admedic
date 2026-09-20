import { type FastifyInstance } from "fastify";
import Fastify from "fastify";
import cors from "@fastify/cors";

import { registerRoutes } from "./routes";

export interface BuildAppOptions {
  logger?: boolean;
}

/** ADR-0001: Fastify v5 + CORS; tüm iş mantığı paketlerde (database/shared), API yalnızca REST taşır. */
export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? process.env.NODE_ENV !== "test",
  });
  await app.register(cors, { origin: true });
  await registerRoutes(app);
  return app;
}

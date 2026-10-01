import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

import { loadEnv } from "@admedic/config";
import { isAdmedicError } from "@admedic/shared";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/**
 * Rust'sız Prisma istemcisi (ADR-0023): bağlantı `pg` sürücü bağdaştırıcısıyla kurulur (istemci motoru
 * `datasourceUrl` ile bağdaştırıcıyı birlikte kabul etmez). `allowExitOnIdle`: boşta bağlantılar betiği açık tutmaz.
 */
export function createPrismaClient(datasourceUrl?: string): PrismaClient {
  const env = loadEnv();
  const connectionString = datasourceUrl ?? env.DATABASE_URL;
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString, allowExitOnIdle: true }),
    log: env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
}

export const prisma =
  globalForPrisma.prisma ??
  createPrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

export { isAdmedicError };

export * from "@prisma/client";
export { anonymizeLead, anonymizeExpiredLeads } from "./privacy";
export { uniqueViolationFields } from "./errors";
export { loadTeamReplyExamples, type TeamReplyExample } from "./assistant-examples";
export {
  applyAdReviewSync,
  type AdReviewStateValue,
  type AdReviewSyncInput,
  type AdReviewSyncItemInput,
  type AdReviewSyncResult,
} from "./ad-review";

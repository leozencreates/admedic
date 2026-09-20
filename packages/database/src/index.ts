import { PrismaClient } from "@prisma/client";

import { loadEnv } from "@admedic/config";
import { isAdmedicError } from "@admedic/shared";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export function createPrismaClient(datasourceUrl?: string): PrismaClient {
  const env = loadEnv();
  return new PrismaClient({
    datasourceUrl: datasourceUrl ?? env.DATABASE_URL,
    log: env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
}

export const prisma =
  globalForPrisma.prisma ??
  createPrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

export { isAdmedicError };

export * from "@prisma/client";
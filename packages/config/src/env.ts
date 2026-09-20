import { createHash } from "crypto";
import { existsSync } from "fs";
import { dirname, join } from "path";
import dotenv from "dotenv";
import { z } from "zod";

export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  APP_NAME: z.string().min(1).default("Admedic"),

  DATABASE_URL: z
    .string()
    .min(1)
    .default("postgresql://localhost:5432/admedic_dev"),
  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),

  AUTH_SECRET: z.string().min(8).default("admedic-dev-only-secret"),
  AUTH_URL: z.string().default("http://localhost:3000"),
  TEST_LAB_URL: z.string().default("http://localhost:3000"),
  AUTOPILOT_URL: z.string().default("http://localhost:3000"),

  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  META_REDIRECT_URI: z
    .string()
    .default("http://localhost:3000/api/meta/oauth/callback"),
  /** Meta Graph API sürümü — KODDA SABİT YAZILMAZ. Örn: v26.0 */
  META_API_VERSION: z
    .string()
    .regex(/^v\d+\.\d+$/, "META_API_VERSION 'vNN.N' biçiminde olmalı (örn. v26.0)")
    .default("v26.0"),
  META_MOCK_MODE: z.coerce.boolean().default(true),

  API_URL: z.string().default("http://localhost:4000"),
  NEXT_PUBLIC_API_URL: z.string().default("http://localhost:4000"),

  ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{0,64}$/, "ENCRYPTION_KEY 64 hex karakter (32 byte) olmalı")
    .optional(),
});

export type AppEnv = z.infer<typeof EnvSchema>;

let cached: AppEnv | undefined;

export interface LoadEnvOptions {
  fresh?: boolean;
  overrides?: Record<string, string | undefined>;
}

export function loadEnv(options: LoadEnvOptions = {}): AppEnv {
  if (cached && !options.fresh) return cached;
  loadRootEnvFile();
  const candidate: Record<string, string | undefined> = { ...process.env };
  if (options.overrides) Object.assign(candidate, options.overrides);
  const parsed = EnvSchema.safeParse(candidate);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Ortam değişkeni doğrulaması başarısız: ${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Monorepo'da cwd'den yukarı çıkarak en yakın `.env` dosyasını yükler (tek kaynak). */
export function loadRootEnvFile(): boolean {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    const file = join(dir, ".env");
    if (existsSync(file)) {
      const r = dotenv.config({ path: file, quiet: true });
      return !r.error;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  dotenv.config({ quiet: true });
  return false;
}

/** Sensitive fields (token'lar vb.) için AES-256-GCM anahtarı. */
export function getEncryptionKey(): Buffer {
  const env = loadEnv();
  if (env.ENCRYPTION_KEY && env.ENCRYPTION_KEY.length === 64) {
    return Buffer.from(env.ENCRYPTION_KEY, "hex");
  }
  const derived = createHash("sha256")
    .update(`admedic-enc:${env.AUTH_SECRET}`)
    .digest();
  return derived;
}
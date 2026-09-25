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
  META_API_VERSION: z.string().regex(/^v\d+\.\d+$/, "META_API_VERSION 'vNN.N' biçiminde olmalı (örn. v26.0)").optional(),
  META_GRAPH_API_VERSION: z.string().optional(),
  META_MOCK_MODE: z.coerce.boolean().default(true),
  META_DISCONNECTED_WEBHOOK_URL: z.string().optional(),

  API_URL: z.string().default("http://localhost:4000"),
  NEXT_PUBLIC_API_URL: z.string().default("http://localhost:4000"),

  ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{0,64}$/, "ENCRYPTION_KEY 64 hex karakter (32 byte) olmalı")
    .optional(),

  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_PRICE_STARTER: z.string().optional(),
  STRIPE_SUCCESS_URL: z.string().optional(),
  STRIPE_CANCEL_URL: z.string().optional(),

  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().default("claude-sonnet-4"),

  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM: z.string().default("Admedic <raporlar@admedic.io>"),
  WEEKLY_REPORT_RECIPIENT: z.string().email().optional(),
  /** 0=Pazar ... 6=Cumartesi; haftalık rapor e-postasının gönderileceği gün */
  WEEKLY_REPORT_DAY: z.coerce.number().int().min(0).max(6).default(0),
});

export type AppEnv = z.infer<typeof EnvSchema> & { metaGraphApiVersion: string };

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
  cached = parsed.data as AppEnv & { metaGraphApiVersion: string };
  const env = cached as AppEnv & { metaGraphApiVersion: string };
  env.metaGraphApiVersion = env.META_GRAPH_API_VERSION ?? env.META_API_VERSION ?? "v26.0";
  return env;
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
import { existsSync } from "fs";
import { dirname, join } from "path";
import dotenv from "dotenv";
import { z } from "zod";

/** Boş string → undefined (".env.example" boş bırakılan alanlar için). */
const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalString = () => z.preprocess(blankToUndefined, z.string().optional());
const graphVersion = () =>
  z.preprocess(
    blankToUndefined,
    z.string().regex(/^v\d+\.\d+$/, "'vNN.N' biçiminde olmalı (örn. v26.0)").optional(),
  );

export const DEV_AUTH_SECRET = "admedic-dev-only-secret";

export const EnvSchema = z.object({
  NODE_ENV: z.preprocess(blankToUndefined, z.enum(["development", "test", "production"]).default("development")),
  LOG_LEVEL: z.preprocess(blankToUndefined, z.enum(["debug", "info", "warn", "error"]).default("info")),
  /** Uygulama adı — kodda sabit yazılmaz (spec §9). */
  APP_NAME: z.preprocess(blankToUndefined, z.string().min(1).default("Admedic")),

  DATABASE_URL: z
    .string()
    .min(1)
    .default("postgresql://localhost:5432/admedic_dev"),
  /** Kuyruk altyapısı (spec §4, henüz kullanılmıyor); ayarlanmadıysa undefined. */
  REDIS_URL: optionalString(),

  AUTH_SECRET: z.preprocess(blankToUndefined, z.string().min(8).default(DEV_AUTH_SECRET)),
  AUTH_URL: z.preprocess(blankToUndefined, z.string().default("http://localhost:3000")),

  META_APP_ID: optionalString(),
  META_APP_SECRET: optionalString(),
  META_REDIRECT_URI: z.preprocess(
    blankToUndefined,
    z.string().default("http://localhost:3000/api/meta/oauth/callback"),
  ),
  /** Meta Graph API sürümü — KODDA SABİT YAZILMAZ. Örn: v26.0 */
  META_API_VERSION: graphVersion(),
  /** Modern ad; META_API_VERSION üzerine önceliklidir. */
  META_GRAPH_API_VERSION: graphVersion(),
  META_MOCK_MODE: z.preprocess(
    (v) => {
      if (typeof v !== "string") return v;
      const n = v.trim().toLowerCase();
      if (n === "" ) return undefined;
      if (["true", "1", "yes", "on"].includes(n)) return true;
      if (["false", "0", "no", "off"].includes(n)) return false;
      return v;
    },
    z.boolean().default(true),
  ),
  /** Üretimde mock modunu bilinçli olarak açık bırakmak için (demo sunucusu); aksi halde üretim mock reddedilir. */
  ALLOW_MOCK_IN_PRODUCTION: z.preprocess(
    (v) => (typeof v === "string" ? ["true", "1", "yes"].includes(v.trim().toLowerCase()) : v),
    z.boolean().default(false),
  ),
  META_DISCONNECTED_WEBHOOK_URL: optionalString(),
  /** Webhook imzası (X-Hub-Signature-256). Meta, App Secret ile imzalar; ayrı bir
   *  değer verilmişse (META_WEBHOOK_SECRET) o kullanılır, yoksa META_APP_SECRET. */
  META_WEBHOOK_SECRET: optionalString(),
  /** Webhook abonelik doğrulaması (hub.verify_token). */
  META_WEBHOOK_VERIFY_TOKEN: optionalString(),

  /** WhatsApp Cloud API — META_MOCK_MODE=true iken gerçek gönderim yapılmaz. */
  WHATSAPP_API_URL: optionalString(),
  WHATSAPP_TOKEN: optionalString(),
  /** Pencere dışı karşılama için onaylı şablon adı (küçük harf/alt çizgi). */
  WHATSAPP_GREETING_TEMPLATE: optionalString(),

  /** Salt okunur Fastify API (apps/api) — masaüstü kabuğu ve web bu adresi kullanır. */
  API_URL: z.string().default("http://127.0.0.1:3001"),
  /** apps/api için zorunlu Bearer belirteci; boşsa API yalnızca mock modunda cevap verir. */
  API_TOKEN: optionalString(),

  /**
   * Alan seviyesinde şifreleme anahtarı: önerilen 64 hex karakter (32 byte). Anahtar scrypt ile
   * türetildiğinden daha kısa hex değerler de (≥ 32 karakter) mevcut verinin çözülebilirliği için
   * kabul edilir; anahtarı DEĞİŞTİRMEK şifreli tüm alanları çözülemez yapar.
   */
  ENCRYPTION_KEY: z.preprocess(
    blankToUndefined,
    z
      .string()
      .regex(/^[0-9a-fA-F]{32,128}$/, "ENCRYPTION_KEY hex karakterlerden oluşmalı (önerilen 64 hex = 32 byte)")
      .optional(),
  ),

  STRIPE_SECRET_KEY: optionalString(),
  STRIPE_WEBHOOK_SECRET: optionalString(),
  STRIPE_PRICE_STARTER: optionalString(),
  STRIPE_PRICE_PROFESSIONAL: optionalString(),
  STRIPE_PRICE_ENTERPRISE: optionalString(),
  STRIPE_SUCCESS_URL: optionalString(),
  STRIPE_CANCEL_URL: optionalString(),

  /** LLM sağlayıcı anahtarı ve modeli — ikisi de ortamdan gelir, varsayılan model yoktur (spec §4). */
  ANTHROPIC_API_KEY: optionalString(),
  LLM_MODEL: optionalString(),

  RESEND_API_KEY: optionalString(),
  /** Gönderen adresi; boşsa APP_NAME ile türetilir. */
  RESEND_FROM: optionalString(),
  /** Ortam düzeyi varsayılan alıcı; Organization.reportRecipient önceliklidir. */
  WEEKLY_REPORT_RECIPIENT: z.preprocess(blankToUndefined, z.string().email().optional()),
  /** 0=Pazar ... 6=Cumartesi; haftalık rapor e-postasının gönderileceği gün (UTC) */
  WEEKLY_REPORT_DAY: z.coerce.number().int().min(0).max(6).default(0),
});

export type AppEnv = z.infer<typeof EnvSchema> & {
  /** Çözümlenmiş Graph API sürümü (META_GRAPH_API_VERSION ?? META_API_VERSION); ayarlanmadıysa undefined. */
  metaGraphApiVersion: string | undefined;
  /** Webhook imzası için kullanılacak gizli anahtar (META_WEBHOOK_SECRET ?? META_APP_SECRET). */
  metaWebhookSecret: string | undefined;
};

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
  const env = parsed.data as AppEnv;
  env.metaGraphApiVersion = env.META_GRAPH_API_VERSION ?? env.META_API_VERSION;
  env.metaWebhookSecret = env.META_WEBHOOK_SECRET ?? env.META_APP_SECRET;
  assertProductionSecrets(env);
  cached = env;
  return env;
}

/** Üretimde geliştirme varsayılanlarıyla çalışmayı engeller (spec §6: gizli anahtar koda yazılmaz). */
function assertProductionSecrets(env: AppEnv) {
  if (env.NODE_ENV !== "production") return;
  // `next build` NODE_ENV=production ile modülleri yükler; yapılandırma denetimi derleme zamanında değil,
  // sunucu çalışırken (`next start`, worker, api) yapılır.
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const problems: string[] = [];
  if (env.AUTH_SECRET === DEV_AUTH_SECRET) problems.push("AUTH_SECRET geliştirme varsayılanında");
  if (!env.ENCRYPTION_KEY) problems.push("ENCRYPTION_KEY ayarlanmadı");
  if (!env.META_MOCK_MODE && !env.metaGraphApiVersion) problems.push("META_API_VERSION ayarlanmadı");
  if (env.META_MOCK_MODE && !env.ALLOW_MOCK_IN_PRODUCTION)
    problems.push("META_MOCK_MODE üretimde açık (gerçek Meta verisi yerine sahte veri üretilir); META_MOCK_MODE=false yapın ya da demo için ALLOW_MOCK_IN_PRODUCTION=true");
  if (problems.length)
    throw new Error(`Üretim ortamı yapılandırması eksik: ${problems.join("; ")}`);
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

export interface LlmConfig {
  apiKey: string;
  model: string;
}

/**
 * LLM yapılandırması: anahtar ve model ortamdan okunur; ikisi de yoksa `null`.
 * Süreç ortamı doğrudan okunur ki testler `vi.stubEnv` ile geçersiz kılabilsin.
 */
export function getLlmConfig(): LlmConfig | null {
  const apiKey = (process.env.ANTHROPIC_API_KEY ?? "").trim();
  const model = (process.env.LLM_MODEL ?? "").trim();
  if (!apiKey || !model) return null;
  return { apiKey, model };
}

/** Kullanıcıya gösterilecek standart LLM yapılandırma hatası. */
export const LLM_NOT_CONFIGURED_MESSAGE =
  "AI için ANTHROPIC_API_KEY ve LLM_MODEL sunucuda ayarlanmalı.";

/**
 * Çözümlenmiş Graph API sürümü. Ayarlanmadıysa hata fırlatır; koda sabit sürüm yazılmaz.
 * Mock modunda gerçek istek yapılmadığı için "v0.0" yer tutucusu döner.
 */
export function requireGraphVersion(override?: string): string {
  if (override) {
    if (!/^v\d+\.\d+$/.test(override)) throw new Error(`Geçersiz Graph API sürümü: '${override}'`);
    return override;
  }
  const env = loadEnv();
  if (env.metaGraphApiVersion) return env.metaGraphApiVersion;
  if (env.META_MOCK_MODE) return "v0.0";
  throw new Error("META_API_VERSION (veya META_GRAPH_API_VERSION) ayarlanmadı (örn. v26.0).");
}

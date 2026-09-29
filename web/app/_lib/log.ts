import pino from "pino";

/**
 * Sunucu günlüğü (ADR-0023, spec §4 gözlemlenebilirlik): tek satırlık JSON (kapsayıcı günlük sürücüsü toplar).
 * Kişisel veri ve gizli değerler yazılmaz: aşağıdaki alanlar her derinlikte "[gizli]" olur. Yine de kayda
 * hasta metni, e-posta, telefon ya da ad koymayın; yalnızca kimlik ve sayı yazın.
 */
export const LOG_REDACT_PATHS = [
  "authorization",
  "cookie",
  "token",
  "accessToken",
  "password",
  "secret",
  "email",
  "phone",
  "firstName",
  "lastName",
  "content",
  "*.authorization",
  "*.cookie",
  "*.token",
  "*.accessToken",
  "*.password",
  "*.secret",
  "*.email",
  "*.phone",
  "*.firstName",
  "*.lastName",
  "*.content",
];

const level = process.env.LOG_LEVEL?.trim() || (process.env.NODE_ENV === "test" ? "silent" : "info");

export const logger = pino({
  level,
  base: { service: "web" },
  redact: { paths: LOG_REDACT_PATHS, censor: "[gizli]" },
  timestamp: pino.stdTimeFunctions.isoTime,
});

/** Hata nesnesinden kişisel veri içermeyen özet: sınıf, Prisma/HTTP kodu ve ilk satırın başı. */
export function errorSummary(error: unknown): { name: string; code?: string; message: string } {
  const code = (error as { code?: unknown } | null)?.code;
  return {
    name: error instanceof Error ? error.name : typeof error,
    ...(code !== undefined ? { code: String(code) } : {}),
    message: error instanceof Error ? error.message.split("\n")[0].slice(0, 200) : String(error).slice(0, 200),
  };
}

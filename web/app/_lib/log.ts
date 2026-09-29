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

const SAFE_ERROR_NAMES = new Set([
  "Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "URIError", "AggregateError",
  "PrismaClientKnownRequestError", "PrismaClientUnknownRequestError", "PrismaClientValidationError",
  "PrismaClientInitializationError", "HttpError",
]);

/** Hata metni ve stack kullanıcı girdisi içerebilir; yalnızca bilinen sınıf ve Prisma/HTTP kodu kaydedilir. */
export function errorSummary(error: unknown): { name: string; code?: string } {
  const code = (error as { code?: unknown } | null)?.code;
  const safeCode = typeof code === "string" && /^P\d{4}$/.test(code)
    ? code
    : typeof code === "number" && Number.isInteger(code) && code >= 100 && code <= 599 ? String(code) : undefined;
  return {
    name: error instanceof Error && SAFE_ERROR_NAMES.has(error.name) ? error.name : "Error",
    ...(safeCode !== undefined ? { code: safeCode } : {}),
  };
}

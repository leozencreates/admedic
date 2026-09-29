import pino from "pino";

/**
 * İşçi günlüğü (ADR-0023): tek satırlık JSON, web ile aynı biçim ve maskeleme. Kayda hasta metni, ad, e-posta
 * ya da telefon konmaz; yalnızca kimlik ve sayı.
 */
const REDACT = ["token", "accessToken", "email", "phone", "content", "firstName", "lastName"];

export const logger = pino({
  level: process.env.LOG_LEVEL?.trim() || (process.env.NODE_ENV === "test" ? "silent" : "info"),
  base: { service: "worker" },
  redact: { paths: [...REDACT, ...REDACT.map((k) => `*.${k}`)], censor: "[gizli]" },
  timestamp: pino.stdTimeFunctions.isoTime,
});

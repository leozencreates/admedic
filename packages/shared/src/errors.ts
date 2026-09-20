/**
 * Uygulama geneli hata kodları (spec: Error classification).
 */
export type ErrorCode =
  | "AUTH_ERROR"
  | "RATE_LIMIT"
  | "PERMISSION_ERROR"
  | "VALIDATION_ERROR"
  | "META_API_ERROR"
  | "NETWORK_ERROR"
  | "INSUFFICIENT_DATA"
  | "POLICY_BLOCKED"
  | "NOT_FOUND"
  | "CONFLICT";

const HTTP_STATUS: Record<ErrorCode, number> = {
  AUTH_ERROR: 401,
  RATE_LIMIT: 429,
  PERMISSION_ERROR: 403,
  VALIDATION_ERROR: 400,
  META_API_ERROR: 502,
  NETWORK_ERROR: 503,
  INSUFFICIENT_DATA: 422,
  POLICY_BLOCKED: 409,
  NOT_FOUND: 404,
  CONFLICT: 409,
};

export class AdmedicError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AdmedicError";
    this.code = code;
    this.status = HTTP_STATUS[code];
    this.details = details;
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export const isAdmedicError = (e: unknown): e is AdmedicError =>
  e instanceof AdmedicError;

export const toErrorPayload = (e: unknown): { code: ErrorCode; message: string } => {
  if (isAdmedicError(e)) return e.toJSON() as { code: ErrorCode; message: string };
  return { code: "META_API_ERROR", message: e instanceof Error ? e.message : "Bilinmeyen hata" };
};
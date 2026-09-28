import { z } from "zod";
import { loadEnv } from "@admedic/config";
import { isAdmedicError } from "@admedic/shared";
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
/**
 * Yazma isteklerinde origin eşleşmesi (CSRF koruması). Yalnızca durum değiştiren
 * yöntemlerde çağrılır; tarayıcılar aynı kaynaklı GET isteklerinde Origin başlığı
 * göndermediği için GET rotalarında KULLANILMAZ.
 */
export function sameOrigin(request: Request) {
  if (request.headers.get("origin") !== new URL(loadEnv().AUTH_URL).origin) {
    throw new HttpError(403, "İstek kaynağı doğrulanamadı.");
  }
}
/** Varsayılan JSON gövde sınırı (bayt). Görsel yükleme gibi uçlar `maxBytes` ile açıkça yükseltir. */
export const DEFAULT_BODY_LIMIT = 32_768;
export async function body<T>(
  request: Request,
  schema: z.ZodType<T>,
  opts: { maxBytes?: number } = {},
): Promise<T> {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new HttpError(415, "JSON içerik bekleniyor.");
  const limit = opts.maxBytes ?? DEFAULT_BODY_LIMIT;
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "İstek gövdesi eksik.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new HttpError(413, "İstek çok büyük.");
    }
    chunks.push(value);
  }
  try {
    return schema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch {
    throw new HttpError(
      400,
      "Formdaki bazı değerler eksik, çok uzun ya da geçersiz. Alanları düzeltip tekrar deneyin.",
    );
  }
}
/** Bilinen hata türlerini HTTP durumuna eşler; bilinmeyenler 503 döner ve ayrıntı sızdırılmaz. */
export function errorToHttp(error: unknown): { status: number; message: string } {
  if (error instanceof HttpError) return { status: error.status, message: error.message };
  if (isAdmedicError(error)) {
    // Meta API ve doğrulama hataları kullanıcıya anlamlı mesajla döner (token/PII içermez).
    return { status: error.status, message: error.message };
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "P2002")
    return { status: 409, message: "Aynı kayıt zaten var; eşzamanlı bir değişiklik olabilir, yenileyip tekrar deneyin." };
  if (code === "P2025") return { status: 404, message: "Kayıt bulunamadı." };
  if (code === "P2028" || code === "P2034")
    return { status: 409, message: "İşlem eşzamanlı bir değişiklikle çakıştı; tekrar deneyin." };
  return {
    status: 503,
    message: "İşlem tamamlanamadı. Birkaç dakika sonra tekrar deneyin; sorun sürerse yöneticinize bildirin.",
  };
}
export async function respond(action: () => Promise<unknown>) {
  try {
    return Response.json(await action(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const mapped = errorToHttp(error);
    if (mapped.status >= 500 && !(error instanceof HttpError)) {
      // Kişisel veri içermeyen kısa teşhis satırı (hata sınıfı + Prisma kodu).
      const code = (error as { code?: unknown } | null)?.code;
      console.error(
        `[api] ${error instanceof Error ? error.name : "Error"}${code ? ` ${String(code)}` : ""}: ${
          error instanceof Error ? error.message.slice(0, 200) : "unknown"
        }`,
      );
    }
    return Response.json(
      { error: mapped.message },
      { status: mapped.status, headers: { "Cache-Control": "no-store" } },
    );
  }
}

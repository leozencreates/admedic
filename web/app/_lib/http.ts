import { z } from "zod";
import { loadEnv } from "@admedic/config";
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function sameOrigin(request: Request) {
  if (request.headers.get("origin") !== new URL(loadEnv().AUTH_URL).origin) {
    throw new HttpError(403, "İstek kaynağı doğrulanamadı.");
  }
}
export async function body<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<T> {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new HttpError(415, "JSON içerik bekleniyor.");
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "İstek gövdesi eksik.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 32_768) {
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
      "Alanları kontrol edin; boş, fazla uzun veya geçersiz değerler var.",
    );
  }
}
export async function respond(action: () => Promise<unknown>) {
  try {
    return Response.json(await action(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof HttpError
            ? error.message
            : "İşlem tamamlanamadı. Veritabanı bağlantısını kontrol edip tekrar deneyin.",
      },
      {
        status: error instanceof HttpError ? error.status : 503,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}

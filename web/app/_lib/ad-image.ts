import { z } from "zod";
import { HttpError } from "./http";

/**
 * Reklam görseli sınırı. Meta çok daha büyük dosya kabul eder; sınır, JSON (base64) gövdenin
 * sunucusuz ortamların istek gövdesi sınırına (~4,5 MB) sığması için seçildi. 1080×1080 bir
 * reklam görseli tipik olarak bunun çok altındadır.
 */
export const MAX_AD_IMAGE_BYTES = 3 * 1024 * 1024;
/** base64 ≈ 4/3 × ham boyut + JSON alanları için pay. */
export const MAX_AD_IMAGE_REQUEST_BYTES = Math.ceil((MAX_AD_IMAGE_BYTES * 4) / 3) + 4096;
/** Meta'nın akış görselleri için önerdiği en küçük kenar (öneri; engellemez). */
export const RECOMMENDED_MIN_EDGE = 1080;

export const ImageUploadSchema = z
  .object({
    filename: z.string().trim().min(1).max(120),
    /** Ham base64 veya `data:image/...;base64,` önekli veri. */
    dataBase64: z.string().min(16).max(MAX_AD_IMAGE_REQUEST_BYTES),
  })
  .strict();

export interface DecodedAdImage {
  base64: string;
  bytes: number;
  type: "image/jpeg" | "image/png";
  filename: string;
  width: number | null;
  height: number | null;
  warnings: string[];
}

function pngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24 || buf.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function jpegSize(buf: Buffer): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = buf[offset + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = buf.readUInt16BE(offset + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

/**
 * Yüklenen görseli çözer ve doğrular: yalnızca JPEG/PNG (sihirli baytlarla; uzantıya güvenilmez),
 * en fazla {@link MAX_AD_IMAGE_BYTES}. Boyutlar okunabiliyorsa döner; önerinin altındaysa uyarı üretir.
 */
export function decodeAdImage(input: z.infer<typeof ImageUploadSchema>): DecodedAdImage {
  const raw = input.dataBase64.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw new HttpError(400, "Görsel verisi okunamadı. Dosyayı yeniden seçip tekrar yükleyin.");
  const buf = Buffer.from(raw, "base64");
  if (buf.length === 0) throw new HttpError(400, "Görsel dosyası boş. Başka bir JPEG veya PNG seçin.");
  if (buf.length > MAX_AD_IMAGE_BYTES)
    throw new HttpError(413, `Görsel en fazla ${Math.round(MAX_AD_IMAGE_BYTES / (1024 * 1024))} MB olabilir. Daha küçük bir dosya seçin.`);
  const isJpeg = buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const isPng = buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (!isJpeg && !isPng) throw new HttpError(422, "Yalnızca JPEG veya PNG görsel yüklenebilir. Dosyayı bu biçimlerden birinde kaydedip yeniden yükleyin.");
  const type = isJpeg ? "image/jpeg" : "image/png";
  const size = isJpeg ? jpegSize(buf) : pngSize(buf);
  const base = input.filename.replace(/\.[^.]*$/, "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "reklam-gorseli";
  const warnings: string[] = [];
  if (size && (size.width < RECOMMENDED_MIN_EDGE || size.height < RECOMMENDED_MIN_EDGE))
    warnings.push(
      `Görsel ${size.width}×${size.height} px; Meta akış reklamları için en az ${RECOMMENDED_MIN_EDGE}×${RECOMMENDED_MIN_EDGE} px önerir.`,
    );
  return {
    base64: buf.toString("base64"),
    bytes: buf.length,
    type,
    filename: `${base}.${isJpeg ? "jpg" : "png"}`,
    width: size?.width ?? null,
    height: size?.height ?? null,
    warnings,
  };
}

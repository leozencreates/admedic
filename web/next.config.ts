import path from "node:path";
import type { NextConfig } from "next";

/**
 * Güvenlik başlıkları (ADR-0023). İçerik güvenliği politikası bilinçli olarak dar tutuldu: çerçeveleme,
 * eklenti ve form hedefi kısıtlanır; betik/stil kaynakları kısıtlanmaz (Next satır içi betikleri için nonce
 * altyapısı ayrı bir iştir). HSTS yalnızca HTTPS üzerinden gelen yanıtta tarayıcıca dikkate alınır.
 */
const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  turbopack: {},
  // Sunucu imajı (ADR-0023): `.next/standalone` yalnızca gereken dosyaları içerir; monorepo paketleri
  // (`packages/*`) izlensin diye izleme kökü depo köküdür.
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname, ".."),
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;

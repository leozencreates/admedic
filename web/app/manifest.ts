import type { MetadataRoute } from "next";
import { loadEnv } from "@admedic/config";

export const dynamic = "force-dynamic";

export default function manifest(): MetadataRoute.Manifest {
  const { APP_NAME } = loadEnv();
  return {
    name: APP_NAME,
    short_name: APP_NAME,
    start_url: "/",
    display: "standalone",
    background_color: "#0b0e1a",
    theme_color: "#0f1324",
    icons: [
      { src: "/icons/adm-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/adm-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}

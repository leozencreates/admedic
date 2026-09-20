import type { Metadata } from "next";
import { loadEnv } from "@admedic/config";

import { Nav } from "./_components/nav";
import { Account } from "./_components/account";
import "./globals.css";

export function generateMetadata(): Metadata {
  const env = loadEnv();
  return {
    title: `${env.APP_NAME} Panel`,
    description: "Meta reklam optimizasyon paneli",
  };
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const env = loadEnv();
  return (
    <html lang="tr">
      <body className="min-h-screen">
        <div className="app-shell">
          <aside className="app-sidebar">
            <div>
              <p className="text-xl font-semibold tracking-tight text-white">
                {env.APP_NAME}
              </p>
              <p className="mt-2 text-xs text-slate-400">
                REKLAM & BÜYÜME STÜDYOSU
              </p>
            </div>
            <Nav />
            <Account />
            <div className="mt-auto space-y-1 text-xs text-slate-400">
              <p>
                Meta Graph:{" "}
                <span className="font-mono text-slate-500">
                  {env.META_API_VERSION}
                </span>
              </p>
              <p>
                Mod:{" "}
                <span className="font-mono text-slate-500">
                  {env.META_MOCK_MODE ? "MOCK" : "CANLI"}
                </span>
              </p>
            </div>
          </aside>
          <main className="app-main">
            <div className="mb-8 flex items-center justify-between border-b border-slate-200 pb-4 text-xs text-slate-500">
              <span>Çalışma alanı / Klinik reklam yönetimi</span>
              <span className="status-pill">
                {env.META_MOCK_MODE ? "Demo ortamı" : "Canlı veri ortamı"}
              </span>
            </div>
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}

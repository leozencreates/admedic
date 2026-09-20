import type { Metadata } from "next";
import { loadEnv } from "@admedic/config";

import { Nav } from "./_components/nav";
import "./globals.css";

export function generateMetadata(): Metadata {
  const env = loadEnv();
  return {
    title: `${env.APP_NAME} Panel`,
    description: "Meta reklam optimizasyon paneli",
  };
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const env = loadEnv();
  return (
    <html lang="tr">
      <body className="min-h-screen">
        <div className="mx-auto flex min-h-screen max-w-7xl gap-6 p-6">
          <aside className="flex w-60 shrink-0 flex-col gap-6">
            <div>
              <p className="text-lg font-semibold tracking-tight text-slate-900">
                {env.APP_NAME}
              </p>
              <p className="text-xs text-slate-500">Klinik Meta Reklam Paneli</p>
            </div>
            <Nav />
            <div className="mt-auto space-y-1 text-xs text-slate-400">
              <p>
                Meta Graph: <span className="font-mono text-slate-500">{env.META_API_VERSION}</span>
              </p>
              <p>
                Mod:{" "}
                <span className="font-mono text-slate-500">
                  {env.META_MOCK_MODE ? "MOCK" : "CANLI"}
                </span>
              </p>
            </div>
          </aside>
          <main className="min-w-0 flex-1">{children}</main>
        </div>
      </body>
    </html>
  );
}

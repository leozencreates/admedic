import type { Metadata } from "next";
import { cookies } from "next/headers";
import { loadEnv } from "@admedic/config";

import { Nav } from "./_components/nav";
import { Account } from "./_components/account";
import { LanguageSwitcher } from "./_components/language-switcher";
import { UI_LANG_COOKIE, navLinks, parseLanguage, t } from "./_lib/i18n";
import "./globals.css";

/** UI dili `ui-lang` çerezinden (tr|en, varsayılan tr) okunur; kaynak: web/app/_lib/i18n.ts. */
async function currentLanguage() {
  return parseLanguage((await cookies()).get(UI_LANG_COOKIE)?.value);
}

export async function generateMetadata(): Promise<Metadata> {
  const env = loadEnv();
  const lang = await currentLanguage();
  return {
    title: `${env.APP_NAME} ${t("layout.panel", lang)}`,
    description: t("layout.description", lang),
  };
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const env = loadEnv();
  const lang = await currentLanguage();
  return (
    <html lang={lang}>
      <body className="min-h-screen">
        <div className="app-shell">
          <aside className="app-sidebar">
            <div>
              <p className="text-xl font-semibold tracking-tight text-white">
                {env.APP_NAME}
              </p>
              <p className="mt-2 text-xs text-slate-400">
                {t("layout.tagline", lang)}
              </p>
            </div>
            <Nav links={navLinks(lang)} />
            <Account lang={lang} />
            <div className="mt-auto space-y-2 text-xs text-slate-400">
              <LanguageSwitcher initial={lang} />
              <p>
                {t("layout.metaGraph", lang)}:{" "}
                <span className="font-mono text-slate-500">
                  {env.metaGraphApiVersion ?? "—"}
                </span>
              </p>
              <p>
                {t("layout.mode", lang)}:{" "}
                <span className="font-mono text-slate-500">
                  {env.META_MOCK_MODE ? t("layout.modeMock", lang) : t("layout.modeLive", lang)}
                </span>
              </p>
            </div>
          </aside>
          <main className="app-main">
            <div className="mb-8 flex items-center justify-between border-b border-slate-200 pb-4 text-xs text-slate-500">
              <span>{t("layout.breadcrumb", lang)}</span>
              <span className="status-pill">
                {env.META_MOCK_MODE ? t("layout.envDemo", lang) : t("layout.envLive", lang)}
              </span>
            </div>
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}

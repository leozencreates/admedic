import type { Metadata } from "next";
import { cookies } from "next/headers";
import { loadEnv } from "@admedic/config";

import { AppShell } from "./_components/app-shell";
import { UI_LANG_COOKIE, navLinks, parseLanguage, t } from "./_lib/i18n";
import "./globals.css";

/** UI dili `ui-lang` çerezinden (tr|en, varsayılan tr) okunur; kaynak: web/app/_lib/i18n.ts. */
async function currentLanguage() {
  return parseLanguage((await cookies()).get(UI_LANG_COOKIE)?.value);
}

/**
 * Sekme başlığı şablonu: her bölüm kendi adını verir ("Lead CRM · <APP_NAME>").
 * Uygulama adı koda yazılmaz; `APP_NAME` ortam değişkeninden gelir.
 */
export async function generateMetadata(): Promise<Metadata> {
  const env = loadEnv();
  const lang = await currentLanguage();
  return {
    title: { default: env.APP_NAME, template: `%s · ${env.APP_NAME}` },
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
        <AppShell
          appName={env.APP_NAME}
          tagline={t("layout.tagline", lang)}
          links={navLinks(lang)}
          lang={lang}
          labels={{
            skip: t("layout.skip", lang),
            mainNav: t("layout.mainNav", lang),
            menu: t("layout.menu", lang),
            menuClose: t("layout.menuClose", lang),
          }}
          envLabel={env.META_MOCK_MODE ? t("layout.envDemo", lang) : t("layout.envLive", lang)}
          footerLines={[
            `${t("layout.metaGraph", lang)}: ${env.metaGraphApiVersion ?? "—"}`,
            `${t("layout.mode", lang)}: ${env.META_MOCK_MODE ? t("layout.modeMock", lang) : t("layout.modeLive", lang)}`,
          ]}
        >
          {children}
        </AppShell>
      </body>
    </html>
  );
}

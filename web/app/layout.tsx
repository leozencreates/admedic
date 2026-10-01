import type { Metadata } from "next";
import { cookies } from "next/headers";
import { loadEnv } from "@admedic/config";

// IBM Plex Sans (+ Arapça) yerel paketlerden gelir; derleme ve çalışma sırasında ağ gerekmez (ADR-0017).
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-sans-arabic/400.css";
import "@fontsource/ibm-plex-sans-arabic/600.css";

import { AppShell } from "./_components/app-shell";
import { currentActor } from "./_lib/auth";
import { UI_LANG_COOKIE, parseLanguage, t } from "./_lib/i18n";
import "./globals.css";

/** UI dili `ui-lang` çerezinden (tr|en, varsayılan tr) okunur; kaynak: web/app/_lib/i18n.ts. */
async function currentLanguage() {
  return parseLanguage((await cookies()).get(UI_LANG_COOKIE)?.value);
}

/**
 * Sekme başlığı şablonu: her bölüm kendi adını verir ("Lead'ler · <APP_NAME>").
 * Uygulama adı koda yazılmaz; `APP_NAME` ortam değişkeninden gelir.
 */
export async function generateMetadata(): Promise<Metadata> {
  const env = loadEnv();
  const lang = await currentLanguage();
  return {
    title: { default: env.APP_NAME, template: `%s · ${env.APP_NAME}` },
    description: t("layout.description", lang),
    // iPhone/iPad'de "Ana Ekrana Ekle" ile açıldığında Safari çubukları olmadan, ürün adıyla çalışır (ADR-0025).
    appleWebApp: { capable: true, title: env.APP_NAME, statusBarStyle: "default" },
  };
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const env = loadEnv();
  const lang = await currentLanguage();
  // Menü ilk çizimde role göre süzülsün diye rol sunucuda okunur; oturum yoksa null (giriş sayfası).
  const actor = await currentActor().catch(() => null);
  return (
    <html lang={lang}>
      <body className="min-h-screen">
        <AppShell
          appName={env.APP_NAME}
          lang={lang}
          initialRole={actor?.role ?? null}
          isDemo={env.META_MOCK_MODE}
          metaLines={[
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

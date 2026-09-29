import { cookies } from "next/headers";
import { loadEnv } from "@admedic/config";
import { Login } from "../_components/login";
import { UI_LANG_COOKIE, parseLanguage, t } from "../_lib/i18n";
import type { Metadata } from "next";

export async function generateMetadata(): Promise<Metadata> {
  const lang = parseLanguage((await cookies()).get(UI_LANG_COOKIE)?.value);
  return { title: t("login.heading", lang) };
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string; next?: string }>;
}) {
  const params = await searchParams;
  const lang = parseLanguage((await cookies()).get(UI_LANG_COOKIE)?.value);
  return (
    <Login
      appName={loadEnv().APP_NAME}
      lang={lang}
      initialEmail={typeof params.email === "string" ? params.email : ""}
      next={typeof params.next === "string" ? params.next : undefined}
    />
  );
}

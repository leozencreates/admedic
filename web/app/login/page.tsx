import { cookies } from "next/headers";
import { Login } from "../_components/login";
import { UI_LANG_COOKIE, parseLanguage } from "../_lib/i18n";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string; workspace?: string }>;
}) {
  const params = await searchParams;
  const lang = parseLanguage((await cookies()).get(UI_LANG_COOKIE)?.value);
  return (
    <Login
      lang={lang}
      initialEmail={typeof params.email === "string" ? params.email : ""}
      initialWorkspace={typeof params.workspace === "string" ? params.workspace : ""}
    />
  );
}

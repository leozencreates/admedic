"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "../_lib/client-api";
import { DEFAULT_LANGUAGE, t, type Language } from "../_lib/i18n";
import { safeNextPath } from "../_lib/navigation";

/** Oturum açma formu (ADR-0021): metinler `i18n.ts` sözlüğünden (TR/EN); uygulama adı `APP_NAME`'den gelir. */

export function Login({
  appName,
  lang = DEFAULT_LANGUAGE,
  initialEmail = "",
  initialWorkspace = "",
  next,
}: {
  /** Uygulama adı (`APP_NAME` ortam değişkeni); koda yazılmaz. */
  appName: string;
  lang?: Language;
  initialEmail?: string;
  initialWorkspace?: string;
  /** Oturum açılınca dönülecek uygulama içi yol (`?next=`); yoksa rolün ana sayfası. */
  next?: string;
}) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function login(data: FormData) {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ ok: boolean; home?: string }>("/api/session", "POST", Object.fromEntries(data));
      router.push(safeNextPath(next) ?? safeNextPath(result.home) ?? "/");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("login.failed", lang));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mx-auto max-w-md space-y-6">
      <p className="text-lg font-semibold text-ink">{appName}</p>
      <section className="studio-card">
        <h1 className="text-xl font-semibold text-ink">{t("login.heading", lang)}</h1>
        <p className="mt-1 text-sm text-ink-2">{t("login.lead", lang)}</p>
        <form action={login} className="mt-6 space-y-4">
          <label className="field">
            {t("login.email", lang)}
            <input
              name="email"
              defaultValue={initialEmail}
              type="email"
              autoComplete="username"
              maxLength={254}
              required
            />
          </label>
          <label className="field">
            {t("login.password", lang)}
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              maxLength={256}
              required
            />
          </label>
          <label className="field">
            {t("login.workspace", lang)}
            <input
              name="workspace"
              defaultValue={initialWorkspace}
              autoComplete="off"
              maxLength={100}
              required
            />
          </label>
          <button disabled={busy} className="primary-button w-full">
            {busy ? t("login.submitting", lang) : t("login.submit", lang)}
          </button>
          <p role="alert" className="text-sm text-rose-600">
            {error}
          </p>
        </form>
        <details className="mt-6 text-xs leading-6 text-ink-3">
          <summary className="cursor-pointer">{t("login.firstSetupSummary", lang)}</summary>
          <p>
            {t("login.firstSetupBefore", lang)}{" "}
            <code>pnpm --filter @admedic/web user:create</code>{" "}
            {t("login.firstSetupAfter", lang)}
          </p>
        </details>
      </section>
    </div>
  );
}

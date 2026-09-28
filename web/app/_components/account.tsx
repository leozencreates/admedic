"use client";
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "../_lib/client-api";
import { DEFAULT_LANGUAGE, t, type Language } from "../_lib/i18n";
import { roleLabel } from "../_lib/labels";
import { LanguageSwitcher } from "./language-switcher";

/** Menünün altındaki hesap bloğu: çalışma alanı, rol, arayüz dili ve çıkış (tek dil seçici burada). */
export function Account({ lang = DEFAULT_LANGUAGE }: { lang?: Language }) {
  const pathname = usePathname();
  const router = useRouter();
  const [actor, setActor] = useState<{
    workspaceName: string;
    role: string;
  } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    api<{ actor: typeof actor }>("/api/session")
      .then((data) => {
        if (active) setActor(data.actor);
      })
      .catch(() => {
        if (active) setActor(null);
      });
    return () => {
      active = false;
    };
  }, [pathname]);
  async function logout() {
    try {
      await api("/api/session", "DELETE");
      setActor(null);
      router.push("/login");
      router.refresh();
    } catch {
      setError(t("account.logoutError", lang));
    }
  }
  return (
    <div className="space-y-2 text-xs text-slate-300">
      {actor ? (
        <>
          <p className="text-sm font-medium text-white">{actor.workspaceName}</p>
          <p>{roleLabel(actor.role)}</p>
        </>
      ) : null}
      <div className="flex items-center justify-between gap-3">
        <LanguageSwitcher initial={lang} />
        {actor ? (
          <button type="button" onClick={logout} className="min-h-9 text-sm font-medium text-violet-200 hover:text-white">
            {t("account.logout", lang)}
          </button>
        ) : (
          <Link href="/login" className="text-sm font-medium text-violet-200 hover:text-white">
            {t("account.login", lang)}
          </Link>
        )}
      </div>
      {error ? (
        <p role="alert" className="text-rose-300">
          {error}
        </p>
      ) : null}
    </div>
  );
}

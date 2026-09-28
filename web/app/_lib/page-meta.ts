import { createElement, type ReactNode } from "react";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { requirePageActor } from "./auth";
import { UI_LANG_COOKIE, parseLanguage, t, type TranslationKey } from "./i18n";
import { navItemForSection } from "./nav-tree";
import { RoleRestricted } from "../_components/role-restricted";

/**
 * Bölüm başlığı ve oturum koruması (ADR-0016 · Faz 1 madde 8).
 * Her bölümün `layout.tsx` dosyası sekme adını verir ("Lead CRM · <APP_NAME>", şablon kök layout'ta)
 * ve oturum yoksa girişe `?next=` ile yönlendirir. API uçları yetkiyi ayrıca denetler.
 */
export async function uiLanguage() {
  return parseLanguage((await cookies()).get(UI_LANG_COOKIE)?.value);
}

export async function sectionMetadata(key: TranslationKey): Promise<Metadata> {
  return { title: t(key, await uiLanguage()) };
}

/**
 * Oturum koruması + menüyle aynı rol görünürlüğü: rolün menüde görmediği bölüm doğrudan açılırsa sayfa yerine
 * açıklama gösterilir (ADR-0017 rol tablosu; genel inceleme 2026-09-29).
 */
export function guardedSection(path: string) {
  return async function GuardedSection({ children }: { children: ReactNode }) {
    const actor = await requirePageActor(path);
    const item = navItemForSection(path);
    if (item && !(item.roles as readonly string[]).includes(actor.role))
      return createElement(RoleRestricted, { title: t(item.key, await uiLanguage()) });
    return children;
  };
}

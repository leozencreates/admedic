"use client";
import { useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { Nav } from "./nav";
import { Account } from "./account";
import type { Language, NavLink } from "../_lib/i18n";

/**
 * Uygulama kabuğu (ADR-0016 · Faz 1): "İçeriğe atla" bağlantısı, kendi içinde kayan yan menü
 * (hesap/dil/çıkış her zaman görünür), telefonda "Menü" düğmesiyle açılan menü.
 * Giriş sayfasında menü gösterilmez. Sayfa gövdeleri henüz yalnızca Türkçe olduğundan `main lang="tr"`.
 */
export function AppShell({
  children,
  appName,
  tagline,
  links,
  lang,
  labels,
  envLabel,
  footerLines,
}: {
  children: ReactNode;
  appName: string;
  tagline: string;
  links: NavLink[];
  lang: Language;
  labels: { skip: string; mainNav: string; menu: string; menuClose: string };
  envLabel: string;
  footerLines: string[];
}) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  if (pathname === "/login") {
    return (
      <main id="icerik" lang="tr" className="login-main">
        {children}
      </main>
    );
  }

  return (
    <>
      <a href="#icerik" className="skip-link">
        {labels.skip}
      </a>
      <div className="app-shell">
        <aside className="app-sidebar" data-open={menuOpen ? "true" : "false"}>
          <div className="app-sidebar__head">
            <div>
              <p className="app-brand">{appName}</p>
              <p className="app-tagline">{tagline}</p>
            </div>
            <button
              type="button"
              className="app-menu-toggle"
              aria-expanded={menuOpen}
              aria-controls="ana-menu"
              onClick={() => setMenuOpen((open) => !open)}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
                {menuOpen ? (
                  <>
                    <path d="M18 6 6 18" />
                    <path d="m6 6 12 12" />
                  </>
                ) : (
                  <>
                    <path d="M4 6h16" />
                    <path d="M4 12h16" />
                    <path d="M4 18h16" />
                  </>
                )}
              </svg>
              {menuOpen ? labels.menuClose : labels.menu}
            </button>
          </div>
          <div id="ana-menu" className="app-sidebar__body">
            <Nav links={links} label={labels.mainNav} />
            <div className="app-sidebar__foot">
              <Account lang={lang} />
              <div className="mt-3 space-y-1">
                <span className="status-pill">{envLabel}</span>
                {footerLines.map((line) => (
                  <p key={line}>{line}</p>
                ))}
              </div>
            </div>
          </div>
        </aside>
        <main id="icerik" lang="tr" className="app-main">
          {children}
        </main>
      </div>
    </>
  );
}

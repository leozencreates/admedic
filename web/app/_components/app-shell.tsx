"use client";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Bell, ChevronDown, LogOut, Menu, Plus, Search, X } from "lucide-react";
import { api } from "../_lib/client-api";
import { formatRelative } from "../_lib/format";
import { t, type Language } from "../_lib/i18n";
import { severityStyle } from "../_lib/labels";
import { navContext, navTreeFor, newActionsFor, tabItemsFor, type NavBadge } from "../_lib/nav-tree";
import { Nav, type BadgeCounts } from "./nav";
import { NavGlyph } from "./nav-icons";
import { LanguageSwitcher } from "./language-switcher";

/** `/api/shell` yanıtı: rozet sayıları, bildirimler ve hesap bilgisi (ADR-0017). */
interface ShellSummary {
  user: { name: string; initials: string; role: string; roleLabel: string; workspaceName: string };
  counts: { approvals: number; leads: number; alerts: number };
  notifications: { id: string; title: string; severity: string; createdAt: string; href: string }[];
}

type OpenMenu = "new" | "bell" | "account" | null;

/** Üst çubuktaki lead araması; Lead'ler sayfası bu olayı dinler (aynı sayfadayken URL değişmeden süzer). */
export const LEAD_SEARCH_EVENT = "app:lead-search";

const SUMMARY_REFRESH_MS = 60_000;

/**
 * Uygulama kabuğu (ADR-0017 · Faz 2):
 * - Masaüstü: koyu, gruplu ve rol filtreli yan menü (K2-A) + üst çubuk (arama, ortam, "Yeni", zil, hesap).
 * - Telefon/tablet (K7-A): ince üst çubuk (sayfa adı, arama, zil) + rol bazlı alt sekme çubuğu ve tam ekran menü.
 * - Giriş sayfasında kabuk çizilmez. Sayfa gövdeleri henüz yalnızca Türkçe olduğundan `main lang="tr"`.
 */
export function AppShell({
  children,
  appName,
  lang,
  initialRole,
  isDemo,
  metaLines,
}: {
  children: ReactNode;
  appName: string;
  lang: Language;
  /** Sunucudan gelen rol (ilk çizimde menünün doğru süzülmesi için); özet gelince güncellenir. */
  initialRole: string | null;
  isDemo: boolean;
  metaLines: string[];
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [summary, setSummary] = useState<ShellSummary | null>(null);
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [typing, setTyping] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const topbarRef = useRef<HTMLElement>(null);

  const role = summary?.user.role ?? initialRole;
  const groups = navTreeFor(role, lang);
  const tabs = tabItemsFor(role, lang);
  const newActions = newActionsFor(role);
  const canSearchLeads = groups.some((g) => g.items.some((i) => i.href === "/leads"));
  const context = navContext(pathname, lang);
  const counts: BadgeCounts = summary?.counts ?? {};
  const badgeLabels: Record<NavBadge, string> = {
    approvals: t("shell.pendingBadge", lang),
    leads: t("shell.leadsBadge", lang),
    alerts: t("shell.alertsBadge", lang),
  };
  const isLogin = pathname === "/login";
  // Açık bir lead konuşmasında alt sekme çubuğu yoktur (yazma alanı altta sabit, ADR-0019).
  const inConversation = /^\/leads\/[^/]+$/.test(pathname);

  const loadSummary = useCallback(async () => {
    try {
      setSummary(await api<ShellSummary>("/api/shell"));
    } catch {
      // Oturum yoksa ya da ağ hatasında kabuk sessizce eski hâliyle kalır; sayfa kendi hatasını gösterir.
      setSummary(null);
    }
  }, []);

  // Sayfa değişince menüler kapanır ve sayılar tazelenir; sekme görünürken dakikada bir yenilenir.
  useEffect(() => {
    setOpenMenu(null);
    setSheetOpen(false);
    setSearchOpen(false);
    if (!isLogin) void loadSummary();
  }, [pathname, isLogin, loadSummary]);
  useEffect(() => {
    if (isLogin) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadSummary();
    }, SUMMARY_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [isLogin, loadSummary]);

  // Ctrl+K / ⌘K arama kutusuna odaklanır; Esc açık paneli kapatır.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k" && canSearchLeads) {
        e.preventDefault();
        setSearchOpen(true);
        window.setTimeout(() => searchRef.current?.focus(), 0);
      } else if (e.key === "Escape") {
        setOpenMenu(null);
        setSheetOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canSearchLeads]);

  // Açık panel dışına tıklanınca kapanır.
  useEffect(() => {
    if (!openMenu) return;
    function onPointer(e: PointerEvent) {
      const target = e.target as Node;
      if (!topbarRef.current?.querySelector(".popover-anchor[data-open='true']")?.contains(target)) setOpenMenu(null);
    }
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [openMenu]);

  // Telefonda klavye açıkken (bir alana yazarken) alt sekme çubuğu gizlenir; yazma alanı örtülmez.
  useEffect(() => {
    function onFocus() {
      const el = document.activeElement;
      const editing =
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLInputElement && !["checkbox", "radio", "button", "submit"].includes(el.type)) ||
        (el instanceof HTMLElement && el.isContentEditable);
      setTyping(editing && !topbarRef.current?.contains(el));
    }
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", onFocus);
    return () => {
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("focusout", onFocus);
    };
  }, []);

  function toggle(menu: Exclude<OpenMenu, null>) {
    setOpenMenu((current) => (current === menu ? null : menu));
  }

  function submitSearch(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const q = (searchRef.current?.value ?? "").trim();
    if (pathname === "/leads") {
      window.dispatchEvent(new CustomEvent(LEAD_SEARCH_EVENT, { detail: q }));
      window.history.replaceState(null, "", q ? `/leads?q=${encodeURIComponent(q)}` : "/leads");
    } else {
      router.push(q ? `/leads?q=${encodeURIComponent(q)}` : "/leads");
    }
    setSearchOpen(false);
  }

  async function logout() {
    try {
      await api("/api/session", "DELETE");
      setSummary(null);
      router.push("/login");
      router.refresh();
    } catch {
      setLogoutError(t("account.logoutError", lang));
    }
  }

  if (isLogin) {
    return (
      <main id="icerik" lang="tr" className="login-main">
        {children}
      </main>
    );
  }

  const user = summary?.user;
  const bellCount = summary?.counts.alerts ?? 0;
  const notifications = summary?.notifications ?? [];
  const envLabel = isDemo ? t("layout.envDemo", lang) : t("layout.envLive", lang);

  const accountDetails = (
    <>
      {user ? (
        <div className="px-2.5 py-2">
          <p className="text-sm font-medium text-ink">{user.name}</p>
          <p className="text-xs text-ink-3">
            {user.roleLabel} · {user.workspaceName}
          </p>
        </div>
      ) : null}
    </>
  );

  return (
    <>
      <a href="#icerik" className="skip-link">
        {t("layout.skip", lang)}
      </a>
      <div className="app-shell">
        <aside className="app-sidebar" aria-label={appName}>
          <div className="app-brand">
            <span className="app-brand__mark" aria-hidden="true">
              {appName.charAt(0).toLocaleUpperCase("tr")}
            </span>
            <span className="min-w-0">
              <span className="app-brand__name">{appName}</span>
              <span className="app-brand__sub">{user?.workspaceName ?? t("layout.tagline", lang)}</span>
            </span>
          </div>
          <Nav
            id="yan-menu"
            groups={groups}
            label={t("layout.mainNav", lang)}
            counts={counts}
            badgeLabels={badgeLabels}
          />
          <div className="app-nav__foot">
            <div className="app-nav__meta">
              {metaLines.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
          </div>
        </aside>

        <div className="app-column">
          <header className="app-topbar" ref={topbarRef}>
            <p className="app-topbar__title">{context.page ?? appName}</p>

            {canSearchLeads ? (
              <form role="search" className="app-search" data-open={searchOpen ? "true" : "false"} onSubmit={submitSearch}>
                <Search size={18} strokeWidth={1.75} aria-hidden="true" />
                <label className="sr-only" htmlFor="ust-arama">
                  {t("shell.search", lang)}
                </label>
                <input
                  id="ust-arama"
                  ref={searchRef}
                  type="search"
                  enterKeyHint="search"
                  autoComplete="off"
                  placeholder={t("shell.searchPlaceholder", lang)}
                  onBlur={() => window.setTimeout(() => setSearchOpen(false), 150)}
                />
                <kbd className="kbd" aria-hidden="true">
                  Ctrl K
                </kbd>
              </form>
            ) : null}

            <div className="app-topbar__spacer" />
            <span className="env-chip">{envLabel}</span>

            {canSearchLeads ? (
              <button
                type="button"
                className="icon-button mobile-only"
                aria-label={t("shell.searchOpen", lang)}
                onClick={() => {
                  setSearchOpen(true);
                  window.setTimeout(() => searchRef.current?.focus(), 0);
                }}
              >
                <Search size={20} strokeWidth={1.75} aria-hidden="true" />
              </button>
            ) : null}

            {newActions.length > 0 ? (
              <div className="popover-anchor new-anchor" data-open={openMenu === "new" ? "true" : "false"}>
                <button
                  type="button"
                  className="secondary-button"
                  aria-expanded={openMenu === "new"}
                  aria-controls="yeni-menu"
                  onClick={() => toggle("new")}
                >
                  <Plus size={16} strokeWidth={2} aria-hidden="true" />
                  {t("shell.new", lang)}
                </button>
                {openMenu === "new" ? (
                  <div className="popover" id="yeni-menu">
                    <p className="popover__head">{t("shell.newMenu", lang)}</p>
                    <ul>
                      {newActions.map((action) => (
                        <li key={action.href}>
                          <Link href={action.href} className="popover__item">
                            <Plus size={16} strokeWidth={1.75} aria-hidden="true" />
                            <span>
                              {t(action.key, lang)}
                              <span className="popover__hint">{t(`${action.key}Hint`, lang)}</span>
                            </span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            ) : null}

            {role !== "VIEWER" ? (
              <div className="popover-anchor" data-open={openMenu === "bell" ? "true" : "false"}>
                <button
                  type="button"
                  className="icon-button"
                  aria-expanded={openMenu === "bell"}
                  aria-controls="bildirimler"
                  aria-label={
                    bellCount > 0
                      ? `${t("shell.notifications", lang)}: ${bellCount} ${t("shell.alertsBadge", lang)}`
                      : t("shell.notifications", lang)
                  }
                  onClick={() => toggle("bell")}
                >
                  <Bell size={20} strokeWidth={1.75} aria-hidden="true" />
                  {bellCount > 0 ? (
                    <span className="count-badge" aria-hidden="true">
                      {bellCount > 99 ? "99+" : bellCount}
                    </span>
                  ) : null}
                </button>
                {openMenu === "bell" ? (
                  <div className="popover popover--wide" id="bildirimler">
                    <p className="popover__head">{t("shell.notifications", lang)}</p>
                    {notifications.length === 0 ? (
                      <p className="px-2.5 pb-2 text-sm text-ink-2">{t("shell.notificationsEmpty", lang)}</p>
                    ) : (
                      <ul>
                        {notifications.map((n) => {
                          const sev = severityStyle(n.severity);
                          return (
                            <li key={n.id}>
                              <Link href={n.href} className="popover__item">
                                <span
                                  className={`mt-1.5 size-2 shrink-0 rounded-full ${
                                    sev.tone === "red" ? "bg-bad-fill" : sev.tone === "amber" ? "bg-[#dc6803]" : "bg-[#2e90fa]"
                                  }`}
                                  aria-hidden="true"
                                />
                                <span className="min-w-0">
                                  <span className="block">{n.title}</span>
                                  <span className="popover__hint">
                                    {sev.label} · {formatRelative(new Date(n.createdAt))}
                                  </span>
                                </span>
                              </Link>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                    <div className="popover__sep" />
                    <Link href="/alerts" className="popover__foot">
                      {t("shell.notificationsAll", lang)}
                    </Link>
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="popover-anchor account-anchor" data-open={openMenu === "account" ? "true" : "false"}>
              <button
                type="button"
                className="account-button"
                aria-expanded={openMenu === "account"}
                aria-controls="hesap-menu"
                aria-label={user ? `${t("shell.account", lang)}: ${user.name}, ${user.roleLabel}` : t("shell.account", lang)}
                onClick={() => toggle("account")}
              >
                <span className="avatar" aria-hidden="true">
                  {user?.initials ?? "·"}
                </span>
                {user ? (
                  <span className="account-button__text" aria-hidden="true">
                    <span className="account-button__name">{user.name}</span>
                    <span className="account-button__role">{user.roleLabel}</span>
                  </span>
                ) : null}
                <ChevronDown size={16} strokeWidth={1.75} aria-hidden="true" />
              </button>
              {openMenu === "account" ? (
                <div className="popover" id="hesap-menu">
                  {accountDetails}
                  <div className="popover__sep" />
                  <div className="flex items-center justify-between gap-3 px-2.5 py-1.5 text-sm text-ink-2">
                    <span>{t("lang.label", lang)}</span>
                    <LanguageSwitcher initial={lang} variant="light" />
                  </div>
                  <div className="popover__sep" />
                  <button type="button" className="popover__item" onClick={logout}>
                    <LogOut size={16} strokeWidth={1.75} aria-hidden="true" />
                    {t("account.logout", lang)}
                  </button>
                  {logoutError ? (
                    <p role="alert" className="px-2.5 pb-2 text-xs text-bad">
                      {logoutError}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          </header>

          <main id="icerik" lang="tr" className="app-main">
            {children}
          </main>
        </div>
      </div>

      {/* Telefon/tablet: tam ekran menü (gruplu ağaç + hesap + dil) */}
      <div className="app-sheet" data-open={sheetOpen ? "true" : "false"} id="tam-menu" hidden={!sheetOpen}>
        <Nav id="mobil-menu" groups={groups} label={t("layout.mainNav", lang)} counts={counts} badgeLabels={badgeLabels} />
        <div className="app-sheet__account">
          {user ? (
            <p>
              <strong>{user.name}</strong>
              <br />
              {user.roleLabel} · {user.workspaceName}
            </p>
          ) : null}
          <div className="app-sheet__row">
            <span>{t("lang.label", lang)}</span>
            <LanguageSwitcher initial={lang} />
          </div>
          <div className="app-sheet__row">
            <span className="env-chip">{envLabel}</span>
            <button type="button" className="app-sheet__logout" onClick={logout}>
              {t("account.logout", lang)}
            </button>
          </div>
          {logoutError ? (
            <p role="alert" className="text-sm text-rose-300">
              {logoutError}
            </p>
          ) : null}
        </div>
      </div>

      <nav className="app-tabbar" aria-label={t("layout.tabNav", lang)} data-hidden={typing || inConversation ? "true" : "false"}>
        {tabs.map((tab) => {
          const count = tab.badge ? (counts[tab.badge] ?? 0) : 0;
          const current = context.href === tab.href && !sheetOpen;
          return (
            <Link key={tab.href} href={tab.href} className="app-tab" aria-current={current ? "page" : undefined}>
              <span className="app-tab__icon">
                <NavGlyph icon={tab.icon} size={24} />
                {count > 0 ? (
                  <span className="count-badge" aria-hidden="true">
                    {count > 99 ? "99+" : count}
                  </span>
                ) : null}
              </span>
              <span className="app-tab__label">{tab.label}</span>
              {count > 0 && tab.badge ? (
                <span className="sr-only">
                  , {count} {badgeLabels[tab.badge]}
                </span>
              ) : null}
            </Link>
          );
        })}
        <button
          type="button"
          className="app-tab"
          aria-expanded={sheetOpen}
          aria-controls="tam-menu"
          onClick={() => setSheetOpen((open) => !open)}
        >
          <span className="app-tab__icon">
            {sheetOpen ? <X size={24} strokeWidth={1.75} aria-hidden="true" /> : <Menu size={24} strokeWidth={1.75} aria-hidden="true" />}
          </span>
          <span className="app-tab__label">{t("layout.menu", lang)}</span>
        </button>
      </nav>
    </>
  );
}

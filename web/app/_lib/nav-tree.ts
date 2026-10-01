/**
 * Menü ağacı (ADR-0017 · K2-A): iş alanına göre gruplar + Ayarlar, rol filtreli.
 * Saf modül (sunucu ve istemci). Rotalar Faz 2'de değişmez; birleşmeler (sekmeler) sonraki fazlarda.
 *
 * Rol görünürlüğü yalnızca gezinmeyi sadeleştirir: rolün hiç iş yapamayacağı ya da okumasına gerek olmayan
 * sayfa menüde görünmez. Yetki her API ucunda ayrıca denetlenir; menüden gizlemek güvenlik sınırı değildir.
 */
import { t, type Language, type TranslationKey } from "./i18n";

export type NavRole = "OWNER" | "ADMIN" | "MEDIA_BUYER" | "PATIENT_COORDINATOR" | "ANALYST" | "VIEWER";

/** İkon adı; istemci `lucide-react` bileşenine eşler (`_components/nav-icons.tsx`). */
export type NavIcon =
  | "home"
  | "approvals"
  | "leads"
  | "studio"
  | "library"
  | "languages"
  | "tests"
  | "calculator"
  | "campaigns"
  | "planner"
  | "insights"
  | "recommendations"
  | "decisions"
  | "team"
  | "alerts"
  | "clinic"
  | "meta"
  | "platforms"
  | "guard"
  | "rules"
  | "billing"
  | "launch";

/** Rozet kaynağı: bir insandan eylem bekleyen sayılar (`/api/shell`). */
export type NavBadge = "approvals" | "leads" | "alerts";

export interface NavItemDef {
  href: string;
  key: TranslationKey;
  icon: NavIcon;
  roles: readonly NavRole[];
  badge?: NavBadge;
}

export interface NavGroupDef {
  id: "daily" | "ads" | "tests" | "campaigns" | "performance" | "settings";
  /** Başlıksız grup (günlük iş) menüde başlık göstermez. */
  key: TranslationKey | null;
  items: readonly NavItemDef[];
}

const ALL: readonly NavRole[] = ["OWNER", "ADMIN", "MEDIA_BUYER", "PATIENT_COORDINATOR", "ANALYST", "VIEWER"];
const MANAGE: readonly NavRole[] = ["OWNER", "ADMIN"];
const EDIT: readonly NavRole[] = ["OWNER", "ADMIN", "MEDIA_BUYER"];
const READ_ADS: readonly NavRole[] = ["OWNER", "ADMIN", "MEDIA_BUYER", "ANALYST", "VIEWER"];
const ANALYZE: readonly NavRole[] = ["OWNER", "ADMIN", "MEDIA_BUYER", "ANALYST"];

export const NAV_TREE: readonly NavGroupDef[] = [
  {
    id: "daily",
    key: null,
    items: [
      // Hasta koordinatörünün ana sayfası Lead'ler'dir (navigation.ts); Genel bakış onun işini göstermez.
      { href: "/", key: "nav.overview", icon: "home", roles: ALL.filter((r) => r !== "PATIENT_COORDINATOR") },
      { href: "/approvals", key: "nav.approvals", icon: "approvals", roles: EDIT, badge: "approvals" },
      {
        href: "/leads",
        key: "nav.leads",
        icon: "leads",
        roles: ["OWNER", "ADMIN", "MEDIA_BUYER", "PATIENT_COORDINATOR", "ANALYST"],
        badge: "leads",
      },
    ],
  },
  {
    id: "ads",
    key: "group.ads",
    items: [
      { href: "/studio", key: "nav.studio", icon: "studio", roles: EDIT },
      { href: "/library", key: "nav.library", icon: "library", roles: READ_ADS },
      { href: "/creative", key: "nav.creative", icon: "languages", roles: EDIT },
    ],
  },
  {
    id: "tests",
    key: "group.tests",
    items: [
      { href: "/tests", key: "nav.tests", icon: "tests", roles: READ_ADS },
      { href: "/experiments", key: "nav.experiments", icon: "calculator", roles: ANALYZE },
    ],
  },
  {
    id: "campaigns",
    key: "group.campaigns",
    items: [
      { href: "/campaigns", key: "nav.campaigns", icon: "campaigns", roles: READ_ADS },
      { href: "/campaign-planner", key: "nav.campaignPlanner", icon: "planner", roles: EDIT },
    ],
  },
  {
    id: "performance",
    key: "group.performance",
    items: [
      { href: "/insights", key: "nav.insights", icon: "insights", roles: READ_ADS },
      { href: "/recommendations", key: "nav.recommendations", icon: "recommendations", roles: ANALYZE },
      { href: "/decisions", key: "nav.decisions", icon: "decisions", roles: ANALYZE },
      { href: "/lead-team", key: "nav.leadTeam", icon: "team", roles: ANALYZE },
      {
        href: "/alerts",
        key: "nav.alerts",
        icon: "alerts",
        roles: ["OWNER", "ADMIN", "MEDIA_BUYER", "PATIENT_COORDINATOR", "ANALYST"],
        badge: "alerts",
      },
    ],
  },
  {
    id: "settings",
    key: "group.settings",
    items: [
      { href: "/clinic", key: "nav.clinic", icon: "clinic", roles: EDIT },
      { href: "/meta-connections", key: "nav.metaConnections", icon: "meta", roles: MANAGE },
      { href: "/platforms", key: "nav.platforms", icon: "platforms", roles: MANAGE },
      { href: "/policies", key: "nav.policies", icon: "guard", roles: MANAGE },
      { href: "/policy-rules", key: "nav.policyRules", icon: "rules", roles: EDIT },
      { href: "/billing", key: "nav.billing", icon: "billing", roles: MANAGE },
      { href: "/go-live", key: "nav.goLive", icon: "launch", roles: ["OWNER"] },
    ],
  },
];

/** Tüm menü öğeleri (düz liste). */
export const NAV_ITEMS: readonly NavItemDef[] = NAV_TREE.flatMap((g) => g.items);

export interface NavLinkView {
  href: string;
  label: string;
  icon: NavIcon;
  badge?: NavBadge;
}
export interface NavGroupView {
  id: NavGroupDef["id"];
  label: string | null;
  items: NavLinkView[];
}

function isNavRole(role: string | null | undefined): role is NavRole {
  return !!role && (ALL as readonly string[]).includes(role);
}

/**
 * Role göre menü. Rol bilinmiyorsa (oturum yok ya da yükleniyor) tüm öğeler döner: giriş sayfasında menü
 * zaten çizilmez; oturum düşmüşse sayfalar girişe yönlendirir.
 */
export function navTreeFor(role: string | null | undefined, lang: Language): NavGroupView[] {
  const known = isNavRole(role);
  return NAV_TREE.map((group) => {
    const items = group.items
      .filter((item) => !known || item.roles.includes(role))
      .map((item) => ({ href: item.href, label: t(item.key, lang), icon: item.icon, badge: item.badge }));
    const label = group.key ? t(group.key, lang) : null;
    // Grubun tek öğesi grupla aynı adı taşıyorsa (izleyicide "Kampanyalar") başlık tekrar edilmez.
    return { id: group.id, label: items.length === 1 && items[0].label === label ? null : label, items };
  }).filter((group) => group.items.length > 0);
}

/** Bölümü menüde görebilen roller ve menü adı (sayfa düzeyinde rol koruması için); menüde olmayan yol → null. */
export function navItemForSection(path: string): { roles: readonly NavRole[]; key: TranslationKey } | null {
  const item = NAV_ITEMS.find((i) => i.href === path);
  return item ? { roles: item.roles, key: item.key } : null;
}

/** Yol → menü öğesi (en uzun eşleşen önek). Kayıt sayfaları (`/leads/abc`) üst öğeye bağlanır. */
export function activeNavHref(pathname: string): string | null {
  let best: string | null = null;
  for (const item of NAV_ITEMS) {
    const match = item.href === "/" ? pathname === "/" : pathname === item.href || pathname.startsWith(`${item.href}/`);
    if (match && (!best || item.href.length > best.length)) best = item.href;
  }
  return best;
}

/** Üst çubuk ve ekmek kırıntısı için: sayfanın grubu ve menü adı. */
export function navContext(pathname: string, lang: Language): { group: string | null; page: string | null; href: string | null } {
  const href = activeNavHref(pathname);
  if (!href) return { group: null, page: null, href: null };
  const group = NAV_TREE.find((g) => g.items.some((i) => i.href === href))!;
  const item = group.items.find((i) => i.href === href)!;
  return { group: group.key ? t(group.key, lang) : null, page: t(item.key, lang), href };
}

/**
 * Mobil alt sekme çubuğu (K7-A): rol başına en çok 4 hedef + "Menü".
 * Rolün göremediği hedef atlanır.
 */
const TAB_HREFS: Record<NavRole, readonly string[]> = {
  OWNER: ["/", "/approvals", "/leads", "/campaigns"],
  ADMIN: ["/", "/approvals", "/leads", "/campaigns"],
  MEDIA_BUYER: ["/", "/studio", "/campaigns", "/insights"],
  PATIENT_COORDINATOR: ["/leads", "/alerts"],
  ANALYST: ["/", "/insights", "/campaigns", "/leads"],
  VIEWER: ["/", "/insights", "/campaigns"],
};

export function tabItemsFor(role: string | null | undefined, lang: Language): NavLinkView[] {
  const hrefs = isNavRole(role) ? TAB_HREFS[role] : TAB_HREFS.VIEWER;
  const visible = new Set(navTreeFor(role, lang).flatMap((g) => g.items.map((i) => i.href)));
  return hrefs
    .filter((href) => visible.has(href))
    .map((href) => {
      const item = NAV_ITEMS.find((i) => i.href === href)!;
      const short = TAB_SHORT_LABEL[href];
      return { href, label: t(short ?? item.key, lang), icon: item.icon, badge: item.badge };
    });
}

/** Alt sekme çubuğunda sığmayan menü adlarının kısa hâli (telefonda ~10 karakter). */
const TAB_SHORT_LABEL: Record<string, TranslationKey> = { "/studio": "tab.studio" };

/** "+ Yeni" menüsü: role göre oluşturma kısayolları. */
export interface NewAction {
  href: string;
  key: "new.ad" | "new.campaign" | "new.test";
}
export function newActionsFor(role: string | null | undefined): NewAction[] {
  if (!isNavRole(role) || !EDIT.includes(role)) return [];
  return [
    { href: "/studio", key: "new.ad" },
    { href: "/campaign-planner", key: "new.campaign" },
    { href: "/experiments", key: "new.test" },
  ];
}

"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { activeNavHref, activeRailKey, railItemsFor, type NavBadge, type NavGroupView } from "../_lib/nav-tree";
import type { BadgeCounts } from "./nav";
import { NavGlyph } from "./nav-icons";

/**
 * Masaüstü menüsü (ADR-0030 "Kontrol merkezi"): dar bir şeritte en çok sekiz hedef (simge + görünür ad) ve,
 * etkin hedef bir grupsa, o grubun sayfalarını listeleyen bölüm menüsü. Günlük işlerde (Bugün, Onaylar, Lead'ler)
 * bölüm menüsü yoktur; içerik alanı genişler. Telefon ve tablette bu bileşen gizlenir (alt sekme çubuğu + Menü).
 */
export function RailNav({
  groups,
  label,
  counts,
  badgeLabels,
  brand,
  appName,
  metaLines,
}: {
  groups: NavGroupView[];
  label: string;
  counts: BadgeCounts;
  badgeLabels: Record<NavBadge, string>;
  /** Marka simgesi (süs). */
  brand: ReactNode;
  appName: string;
  /** Ortam bilgisi satırları (Graph sürümü, çalışma modu); bölüm menüsünün altında gösterilir. */
  metaLines: string[];
}) {
  const pathname = usePathname();
  const items = railItemsFor(groups);
  const activeKey = activeRailKey(items, pathname);
  const activeHref = activeNavHref(pathname);
  const section = items.find((item) => item.key === activeKey && item.children.length > 0) ?? null;

  const badge = (count: number, sources: NavBadge[]) =>
    count > 0 ? (
      <span className="count-badge">
        <span aria-hidden="true">{count > 99 ? "99+" : count}</span>
        <span className="sr-only">
          {count} {sources.map((source) => badgeLabels[source]).join(", ")}
        </span>
      </span>
    ) : null;

  return (
    <>
      <nav aria-label={label} className="kc-rail">
        <div className="kc-rail__brand" title={appName}>
          {brand}
        </div>
        <ul className="kc-rail__list">
          {items.map((item) => {
            const total = item.badges.reduce((sum, source) => sum + (counts[source] ?? 0), 0);
            const current = item.key === activeKey;
            return (
              <li key={item.key}>
                <Link
                  href={item.href}
                  className="kc-rail__item"
                  // Grup hedefi bir sayfa değil bölümdür: içindeki sayfa açıkken "true", kendisi açıkken "page".
                  aria-current={current ? (item.children.length > 0 ? "true" : "page") : undefined}
                >
                  <span className="kc-rail__icon">
                    <NavGlyph icon={item.icon} size={20} />
                    {badge(total, item.badges)}
                  </span>
                  <span className="kc-rail__label">{item.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {section ? (
        <nav aria-label={section.label} className="kc-subnav">
          <p className="kc-subnav__title">{section.label}</p>
          <ul className="kc-subnav__list">
            {section.children.map((child) => (
              <li key={child.href}>
                <Link href={child.href} className="kc-subnav__link" aria-current={activeHref === child.href ? "page" : undefined}>
                  <NavGlyph icon={child.icon} />
                  <span className="min-w-0 flex-1">{child.label}</span>
                  {child.badge ? badge(counts[child.badge] ?? 0, [child.badge]) : null}
                </Link>
              </li>
            ))}
          </ul>
          <div className="kc-subnav__foot">
            {metaLines.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
        </nav>
      ) : null}
    </>
  );
}

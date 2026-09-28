"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { activeNavHref, type NavBadge, type NavGroupView } from "../_lib/nav-tree";
import { NavGlyph } from "./nav-icons";

export type BadgeCounts = Partial<Record<NavBadge, number>>;

/**
 * Gruplu yan menü (K2-A). Yan menü ve mobil tam ekran menü aynı bileşeni kullanır.
 * Rozet yalnızca bir insandan eylem bekleyen sayıdır; ekran okuyucu için sayı ve anlamı birlikte okunur.
 */
export function Nav({
  groups,
  label,
  counts,
  badgeLabels,
  id,
}: {
  groups: NavGroupView[];
  label: string;
  counts: BadgeCounts;
  badgeLabels: Record<NavBadge, string>;
  id?: string;
}) {
  const pathname = usePathname();
  const active = activeNavHref(pathname);
  return (
    <nav aria-label={label} className="app-nav" id={id}>
      {groups.map((group) => (
        <div key={group.id} role="group" aria-labelledby={group.label ? `${id ?? "nav"}-${group.id}` : undefined}>
          {group.label ? (
            <p className="app-nav__group" id={`${id ?? "nav"}-${group.id}`}>
              {group.label}
            </p>
          ) : null}
          <ul className="flex flex-col gap-0.5">
            {group.items.map((item) => {
              const count = item.badge ? (counts[item.badge] ?? 0) : 0;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active === item.href ? "page" : undefined}
                    className="app-nav__link"
                  >
                    <NavGlyph icon={item.icon} />
                    <span className="app-nav__label">{item.label}</span>
                    {item.badge && count > 0 ? (
                      <span className="count-badge">
                        <span aria-hidden="true">{count > 99 ? "99+" : count}</span>
                        <span className="sr-only">
                          {count} {badgeLabels[item.badge]}
                        </span>
                      </span>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

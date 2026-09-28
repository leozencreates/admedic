"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { NavLink } from "../_lib/i18n";

/**
 * Yan menü. `usePathname` gerektirdiği için istemci bileşeni kalır; etiketler dile göre
 * sunucuda (`layout.tsx` → `navLinks(lang)`) üretilip prop olarak gelir.
 */
export function Nav({ links, label }: { links: NavLink[]; label: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label={label} className="app-sidebar__nav">
      <ul className="flex flex-col gap-0.5">
        {links.map((link) => {
          const active =
            pathname === link.href ||
            (link.href !== "/" && pathname.startsWith(`${link.href}/`));
          return (
            <li key={link.href}>
              <Link
                href={link.href}
                aria-current={active ? "page" : undefined}
                className={`block rounded-lg px-3 py-2 text-sm font-medium transition ${
                  active
                    ? "bg-violet-500/20 text-white ring-1 ring-violet-400/40"
                    : "text-slate-300 hover:bg-white/5 hover:text-white"
                }`}
              >
                {link.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

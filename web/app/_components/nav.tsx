"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { NavLink } from "../_lib/i18n";

/**
 * Yan menü. `usePathname` gerektirdiği için istemci bileşeni kalır; etiketler dile göre
 * sunucuda (`layout.tsx` → `navLinks(lang)`) üretilip prop olarak gelir.
 */
export function Nav({ links }: { links: NavLink[] }) {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-1">
      {links.map((link) => {
        const active =
          pathname === link.href ||
          (link.href !== "/" && pathname.startsWith(`${link.href}/`));
        return (
          <Link
            key={link.href}
            href={link.href}
            className={`rounded-lg px-3 py-2 text-sm font-medium transition ${
              active
                ? "bg-violet-500/20 text-violet-200 ring-1 ring-violet-400/30"
                : "text-slate-400 hover:bg-white/5 hover:text-white"
            }`}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}

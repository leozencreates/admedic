"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Genel Bakış" },
  { href: "/studio", label: "✦ Reklam Oluştur" },
  { href: "/library", label: "Reklam Kütüphanesi" },
  { href: "/tests", label: "Kayıtlı Deneyler" },
  { href: "/experiments", label: "A/B Test Merkezi" },
  { href: "/campaigns", label: "Kampanyalar" },
  { href: "/platforms", label: "Platformlar" },
  { href: "/meta-connections", label: "Meta Bağlantılar" },
  { href: "/recommendations", label: "Öneriler" },
  { href: "/decisions", label: "Kararlar & Onaylar" },
  { href: "/insights", label: "İçgörüler" },
  { href: "/policy-rules", label: "Politika Kuralları" },
  { href: "/leads", label: "Lead CRM" },
  { href: "/billing", label: "Faturalar" },
  { href: "/alerts", label: "Uyarılar" },
];

export function Nav() {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-1">
      {LINKS.map((link) => {
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

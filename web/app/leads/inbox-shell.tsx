"use client";
import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { LeadInbox } from "./lead-inbox";

/**
 * Gelen kutusu düzeni (ADR-0019 · K4-A): solda lead listesi, sağda seçili lead (sohbet + lead kartı).
 * Liste düzende yaşar; lead değiştirince yeniden yüklenmez. Telefonda seçim yoksa yalnızca liste,
 * seçim varsa yalnızca sohbet görünür (tam ekran; alt sekme çubuğu gizlenir).
 */
export function InboxShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const match = /^\/leads\/([^/]+)$/.exec(pathname);
  const selectedId = match ? decodeURIComponent(match[1]) : null;
  return (
    <div className="inbox" data-selected={selectedId ? "true" : "false"}>
      <aside className="inbox__list" aria-label="Lead listesi">
        <LeadInbox selectedId={selectedId} />
      </aside>
      <section className="inbox__detail" aria-label={selectedId ? "Seçili lead" : undefined}>
        {children}
      </section>
    </div>
  );
}

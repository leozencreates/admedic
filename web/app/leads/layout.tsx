import type { ReactNode } from "react";
import { requirePageActor } from "../_lib/auth";
import { sectionMetadata } from "../_lib/page-meta";
import { InboxShell } from "./inbox-shell";

export const generateMetadata = () => sectionMetadata("nav.leads");

/** Lead gelen kutusu (ADR-0019): liste bu düzende; `/leads/[id]` sağ bölmede açılır. */
export default async function LeadsLayout({ children }: { children: ReactNode }) {
  await requirePageActor("/leads");
  return <InboxShell>{children}</InboxShell>;
}

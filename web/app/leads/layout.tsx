import type { ReactNode } from "react";
import { LEAD_READ_ROLES, requirePageActor } from "../_lib/auth";
import { IntroPanel, PageHeader } from "../_components/ui";
import { sectionMetadata } from "../_lib/page-meta";
import { InboxShell } from "./inbox-shell";

export const generateMetadata = () => sectionMetadata("nav.leads");

/** Lead gelen kutusu (ADR-0019): liste bu düzende; `/leads/[id]` sağ bölmede açılır. */
export default async function LeadsLayout({ children }: { children: ReactNode }) {
  const actor = await requirePageActor("/leads");
  if (!LEAD_READ_ROLES.includes(actor.role))
    return (
      <div className="space-y-6">
        <PageHeader title="Lead'ler" />
        <IntroPanel title="Lead kayıtları bu rol için kapalı">
          İzleyici rolü hasta kayıtlarını görmez; kampanya sonuçlarını Bugün ve İçgörüler sayfalarında izleyebilirsiniz.
          Lead&apos;leri görmeniz gerekiyorsa hesap sahibinden rolünüzü değiştirmesini isteyin.
        </IntroPanel>
      </div>
    );
  return <InboxShell>{children}</InboxShell>;
}

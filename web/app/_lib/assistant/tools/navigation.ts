/**
 * Gezinme araçları (R0, ADR-0028 §3). Yalnızca rolün menüsünde görünen sayfalar açılır (`navTreeFor`) ve her yol
 * `safeNextPath` ile doğrulanır; kayıt sayfaları yalnızca oturum ref'iyle açılır.
 */
import { navTreeFor } from "../../nav-tree";
import { safeNextPath } from "../../navigation";
import { ASSISTANT_CAMPAIGN_TAB_EVENT, type AssistantCampaignTabDetail } from "../page-events";
import { pageKeyForHref } from "../registry";
import { json, type ToolContext, type ToolHandler } from "./context";

export { ASSISTANT_CAMPAIGN_TAB_EVENT } from "../page-events";

/**
 * Asistanın lead arama kutusunu açma isteği. Kabuk (`app-shell.tsx`) dinler ve aramayı açar; metni kullanıcı yazar.
 * `LEAD_SEARCH_EVENT` (sorguyu taşır ve Lead'ler süzgecini değiştirir) bilerek kullanılmaz: boş sorguyla yayınlamak
 * kullanıcının mevcut süzgecini silerdi.
 */
export const ASSISTANT_OPEN_LEAD_SEARCH_EVENT = "app:assistant-open-lead-search";

/** Rolün menüsündeki sayfalar: anahtar → yol ve görünen ad. */
export function allowedPages(ctx: Pick<ToolContext, "role" | "lang">): Map<string, { href: string; label: string }> {
  return new Map(
    navTreeFor(ctx.role, ctx.lang).flatMap((g) => g.items.map((i) => [pageKeyForHref(i.href), { href: i.href, label: i.label }] as const)),
  );
}

/** Rolün menüsünde olmayan ya da güvenli olmayan yol; ileti ajana olduğu gibi gider. */
export class NavigationDenied extends Error {}

function go(ctx: ToolContext, path: string): void {
  const safe = safeNextPath(path);
  if (!safe) throw new NavigationDenied("Bu sayfa açılamıyor.");
  ctx.router.push(safe);
}

function requirePage(ctx: ToolContext, key: string): { href: string; label: string } {
  const page = allowedPages(ctx).get(key);
  if (!page) throw new NavigationDenied("Bu sayfaya erişiminiz yok.");
  return page;
}

export const navigationHandlers: Record<string, ToolHandler> = {
  async navigate_to(params, ctx) {
    const page = requirePage(ctx, String(params.pageKey));
    go(ctx, page.href);
    return { result: `${page.label} sayfası açıldı.` };
  },

  async open_campaign(params, ctx) {
    const id = ctx.refs.resolve(params.ref, "campaign");
    requirePage(ctx, "campaigns");
    const tab = typeof params.tab === "string" && params.tab !== "overview" ? `?tab=${encodeURIComponent(params.tab)}` : "";
    go(ctx, `/campaigns/${encodeURIComponent(id)}${tab}`);
    // Sayfa zaten açıksa sekme olayla değişir (yeni açılan sayfa `?tab` değerini kendisi okur).
    if (typeof window !== "undefined") {
      const detail: AssistantCampaignTabDetail = { campaignId: id, ...(typeof params.tab === "string" ? { tab: params.tab } : {}) };
      window.dispatchEvent(new CustomEvent(ASSISTANT_CAMPAIGN_TAB_EVENT, { detail }));
    }
    return { result: "Kampanya sayfası açıldı.", entityId: id };
  },

  async open_lead(params, ctx) {
    const id = ctx.refs.resolve(params.ref, "lead");
    requirePage(ctx, "leads");
    go(ctx, `/leads/${encodeURIComponent(id)}`);
    return { result: "Lead kaydı açıldı.", entityId: id };
  },

  async open_new_campaign_planner(_params, ctx) {
    const page = requirePage(ctx, "campaign-planner");
    go(ctx, page.href);
    return { result: `${page.label} açıldı. Formu kullanıcı dolduracak.` };
  },

  async open_lead_search(_params, ctx) {
    requirePage(ctx, "leads");
    if (ctx.openLeadSearch) ctx.openLeadSearch();
    else {
      go(ctx, "/leads");
      if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(ASSISTANT_OPEN_LEAD_SEARCH_EVENT));
    }
    return { result: "Lead arama kutusu açıldı. Aranacak metni kullanıcı yazacak." };
  },

  async open_approvals(_params, ctx) {
    const page = requirePage(ctx, "approvals");
    go(ctx, page.href);
    return { result: `${page.label} sayfası açıldı. Onay ve ret sesle yapılmaz; kullanıcı ekrandan karar verir.` };
  },

  async stop_assistant(_params, ctx) {
    // Sonuç gönderildikten sonra kapat (araç yanıtı yarıda kalmasın).
    if (ctx.stop) setTimeout(ctx.stop, 0);
    return { result: json({ status: "stopping" }) };
  },
};

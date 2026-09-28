/**
 * Kayıt referansları (ADR-0016 · Faz 1): ekranda ham kimlik (cmuk…, `AD:…`) yerine kaydın adı ve
 * işlemin yapıldığı sayfaya bağlantı gösterilir.
 * Sunucu modülüdür (Prisma); istemci bileşenleri içe aktarmaz. Her sorgu çalışma alanıyla sınırlıdır:
 * başka çalışma alanının kaydına ad ya da bağlantı üretilmez; bulunamayan kayıt haritada yer almaz.
 */
import { prisma } from "@admedic/database";

/** Kampanya sayfası (ADR-0020): onay, Meta'ya yükleme, etkinleştirme ve performans burada. */
export const campaignHref = (id: string) => `/campaigns/${encodeURIComponent(id)}`;
/** Reklam içeriği (stüdyo taslağı): onay ve düzeltme stüdyoda verilir. */
export const studioDraftHref = (id: string) => `/studio?id=${encodeURIComponent(id)}`;
export const leadHref = (id: string) => `/leads/${encodeURIComponent(id)}`;
/** Kayıtlı A/B testi (stüdyo deneyi). */
export const testHref = (id: string) => `/tests/${encodeURIComponent(id)}`;
export const RECOMMENDATIONS_HREF = "/recommendations";
export const META_CONNECTIONS_HREF = "/meta-connections";

/** Adı bulunamayan hedef (silinmiş ya da başka çalışma alanına ait). */
export const UNKNOWN_TARGET = "Bilinmeyen hedef";

export interface TargetRef {
  targetType: string;
  targetId: string;
}

export const targetKey = (targetType: string, targetId: string) => `${targetType}:${targetId}`;

function idsOf(refs: TargetRef[], type: string): string[] {
  return [...new Set(refs.filter((r) => r.targetType === type).map((r) => r.targetId))];
}

/**
 * Ajan kararı ve bütçe değişikliği hedeflerinin adları (kampanya, reklam seti, reklam).
 * Anahtar `targetKey(tür, kimlik)`; ekranda `names.get(key) ?? UNKNOWN_TARGET`.
 */
export async function targetNames(workspaceId: string, refs: TargetRef[]): Promise<Map<string, string>> {
  const campaignIds = idsOf(refs, "CAMPAIGN");
  const adSetIds = idsOf(refs, "ADSET");
  const adIds = idsOf(refs, "AD");
  const [campaigns, adSets, ads] = await Promise.all([
    campaignIds.length
      ? prisma.campaign.findMany({ where: { workspaceId, id: { in: campaignIds } }, select: { id: true, name: true } })
      : [],
    adSetIds.length
      ? prisma.adSet.findMany({ where: { workspaceId, id: { in: adSetIds } }, select: { id: true, name: true } })
      : [],
    adIds.length
      ? prisma.ad.findMany({ where: { workspaceId, id: { in: adIds } }, select: { id: true, name: true } })
      : [],
  ]);
  const names = new Map<string, string>();
  for (const c of campaigns) names.set(targetKey("CAMPAIGN", c.id), c.name);
  for (const s of adSets) names.set(targetKey("ADSET", s.id), s.name);
  for (const a of ads) names.set(targetKey("AD", a.id), a.name);
  return names;
}

export interface AlertRef {
  id: string;
  entityType: string | null;
  entityId: string | null;
}

/**
 * Uyarının ilgili kaydına bağlantı (uyarı kimliği → adres):
 * - CAMPAIGN → planlayıcıda kampanya; AD / ADSET → bağlı olduğu kampanya.
 * - EXPERIMENT → kayıtlı A/B testi (`/tests/<id>`).
 * - CONVERSATION → konuşmanın lead'i (`/leads/<leadId>`).
 * - META_CONNECTION → Meta bağlantıları sayfası.
 * Kayıt çalışma alanında bulunamazsa (silinmiş, örnek veri) bağlantı üretilmez.
 * Tür adı büyük/küçük harf duyarsızdır (eski kayıtlarda "experiment").
 */
export async function alertRecordLinks(workspaceId: string, alerts: AlertRef[]): Promise<Map<string, string>> {
  const refs = alerts
    .filter((a) => a.entityType && a.entityId)
    .map((a) => ({ alertId: a.id, type: (a.entityType as string).toUpperCase(), id: a.entityId as string }));
  const ids = (type: string) => [...new Set(refs.filter((r) => r.type === type).map((r) => r.id))];
  const campaignIds = ids("CAMPAIGN");
  const adSetIds = ids("ADSET");
  const adIds = ids("AD");
  const experimentIds = ids("EXPERIMENT");
  const conversationIds = ids("CONVERSATION");

  const [campaigns, adSets, ads, experiments, conversations] = await Promise.all([
    campaignIds.length
      ? prisma.campaign.findMany({ where: { workspaceId, id: { in: campaignIds } }, select: { id: true } })
      : [],
    adSetIds.length
      ? prisma.adSet.findMany({ where: { workspaceId, id: { in: adSetIds } }, select: { id: true, campaignId: true } })
      : [],
    adIds.length
      ? prisma.ad.findMany({
          where: { workspaceId, id: { in: adIds } },
          select: { id: true, adSet: { select: { campaignId: true } } },
        })
      : [],
    experimentIds.length
      ? prisma.studioExperiment.findMany({
          where: { id: { in: experimentIds }, draft: { workspaceId } },
          select: { id: true },
        })
      : [],
    conversationIds.length
      ? prisma.conversation.findMany({ where: { workspaceId, id: { in: conversationIds } }, select: { id: true, leadId: true } })
      : [],
  ]);

  const hrefs = new Map<string, string>();
  for (const c of campaigns) hrefs.set(`CAMPAIGN:${c.id}`, campaignHref(c.id));
  for (const s of adSets) hrefs.set(`ADSET:${s.id}`, campaignHref(s.campaignId));
  for (const a of ads) hrefs.set(`AD:${a.id}`, campaignHref(a.adSet.campaignId));
  for (const e of experiments) hrefs.set(`EXPERIMENT:${e.id}`, testHref(e.id));
  for (const c of conversations) hrefs.set(`CONVERSATION:${c.id}`, leadHref(c.leadId));

  const links = new Map<string, string>();
  for (const r of refs) {
    const href = r.type === "META_CONNECTION" ? META_CONNECTIONS_HREF : hrefs.get(`${r.type}:${r.id}`);
    if (href) links.set(r.alertId, href);
  }
  return links;
}

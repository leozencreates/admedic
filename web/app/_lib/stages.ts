/**
 * Aşama şeridi (K8-C, ADR-0018): kaydın akıştaki yeri + "sıradaki adım" etiketi (K8-B etiketleri).
 * Saf modül (sunucu ve istemci). Renk tek başına anlam taşımaz: şeritle birlikte her zaman etiket ve
 * ekran okuyucu cümlesi ("Aşama 4/5: Etkinleştirme bekliyor") gösterilir.
 *
 * Mevcut aşamanın durumu:
 * - human    : bir insandan eylem bekleniyor (amber)
 * - progress : süreç ilerliyor, kimsenin bir şey yapması gerekmiyor (mavi)
 * - problem  : düzeltme gerekiyor / sorun (kırmızı)
 * - done     : akış tamamlandı (tüm bölümler yeşil)
 * - idle     : pasif/kapandı (gri; arşiv, kayıp lead)
 */
import { campaignWorkflowStyle, leadStatusStyle, LEAD_STAGES, type StatusStyle } from "./labels";

export type StageState = "human" | "progress" | "problem" | "done" | "idle";

export interface StageInfo {
  /** 0 tabanlı mevcut aşama. */
  index: number;
  total: number;
  names: readonly string[];
  state: StageState;
  /** Görünen durum etiketi (K8-B). */
  label: string;
  tone: StatusStyle["tone"];
}

export const CAMPAIGN_STAGE_NAMES = ["Taslak", "Onay", "Meta'ya yükleme", "Etkinleştirme", "Yayında"] as const;
export const LEAD_STAGE_NAMES = ["Yeni", "Görüşme", "Nitelikli", "Konsültasyon", "Seyahat", "Tedavi"] as const;

/** Kampanya iş akışı → aşama. `publishIncomplete`: onaylı ama Meta'ya yüklemesi yarım kalmış. */
export function campaignStage(
  workflowStatus: string | null | undefined,
  options: {
    publishIncomplete?: boolean;
    metaPaused?: boolean;
    /** Meta'da oluşturulmuş (bu akıştan geçmemiş) kampanya: iş akışı aşamaları uygulanmaz; Meta durumu gösterilir. */
    external?: boolean;
    /** Kampanyanın Meta'daki durumu (EntityStatus): ACTIVE / PAUSED / ARCHIVED … */
    metaStatus?: string | null;
  } = {},
): StageInfo {
  const style = campaignWorkflowStyle(workflowStatus, options);
  const base = { total: CAMPAIGN_STAGE_NAMES.length, names: CAMPAIGN_STAGE_NAMES, label: style.label, tone: style.tone };
  if (options.external) {
    const active = options.metaStatus === "ACTIVE";
    return {
      ...base,
      index: 4,
      state: active ? "done" : "idle",
      label: active ? "Meta'da yayında" : options.metaStatus === "PAUSED" ? "Meta'da duraklatıldı" : "Meta'da yönetiliyor",
      tone: active ? "green" : "gray",
    };
  }
  switch (workflowStatus) {
    case "IN_REVIEW":
      return { ...base, index: 1, state: "human" };
    case "REJECTED":
      return { ...base, index: 1, state: "problem" };
    case "APPROVED":
      return { ...base, index: 2, state: options.publishIncomplete ? "human" : "progress" };
    case "PUBLISHED_PAUSED":
      return { ...base, index: 3, state: "human" };
    case "ACTIVE":
      return options.metaPaused ? { ...base, index: 4, state: "idle" } : { ...base, index: 4, state: "done" };
    case "ARCHIVED":
      return { ...base, index: 4, state: "idle" };
    default:
      return { ...base, index: 0, state: "progress" };
  }
}

/**
 * Lead durumu → aşama. Kayıp lead gri; son bilinen aşama bilinmediği için ilk aşamada gösterilir.
 * Amber ("bir insan bekliyor") yalnızca gelen kutusu kuralına göre yanıt bekleyen lead'de (`needsReply`, inbox.ts);
 * asistanın yürüttüğü yeni lead amber değildir.
 */
export function leadStage(status: string | null | undefined, options: { needsReply?: boolean } = {}): StageInfo {
  const style = leadStatusStyle(status);
  const base = { total: LEAD_STAGE_NAMES.length, names: LEAD_STAGE_NAMES, label: style.label, tone: style.tone };
  if (status === "LOST") return { ...base, index: 0, state: "idle" };
  const index = Math.max(0, (LEAD_STAGES as readonly string[]).indexOf(status ?? ""));
  if (status === "TREATED") return { ...base, index, state: "done" };
  return { ...base, index, state: options.needsReply ? "human" : "progress" };
}

/** Ekran okuyucu cümlesi: "Aşama 4/5 (Etkinleştirme): Etkinleştirme bekliyor". */
export function stageSentence(stage: StageInfo): string {
  return `Aşama ${stage.index + 1}/${stage.total} (${stage.names[stage.index]}): ${stage.label}`;
}

/**
 * Meta'da oluşturulmuş (Admedic onay akışına hiç girmemiş) kampanya: Meta kimliği var, yayın durumu EXTERNAL ve
 * iş akışı hâlâ taslak. Akışa girmiş (onaya gönderilmiş, yüklenmiş, etkinleştirilmiş) kampanya dış sayılmaz.
 */
export function isExternalCampaign(c: { workflowStatus: string; publish: { status: string } }): boolean {
  return c.publish.status === "EXTERNAL" && c.workflowStatus === "DRAFT";
}

import type { Tone } from "../_components/ui";

export interface StatusStyle {
  label: string;
  tone: Tone;
}

const APPROVAL: Record<string, StatusStyle> = {
  PENDING: { label: "Onay bekliyor", tone: "amber" },
  APPROVED: { label: "Onaylandı", tone: "green" },
  REJECTED: { label: "Reddedildi", tone: "red" },
  NOT_REQUIRED: { label: "Onay gerekmez", tone: "gray" },
};

const ACTION: Record<string, StatusStyle> = {
  INCREASE_BUDGET: { label: "Bütçe artır", tone: "green" },
  DECREASE_BUDGET: { label: "Bütçe azalt", tone: "blue" },
  PAUSE: { label: "Durdur", tone: "red" },
  KEEP: { label: "Koru", tone: "gray" },
  CREATE_VARIANT: { label: "Varyant oluştur", tone: "violet" },
  SCALE_CAMPAIGN: { label: "Kampanya ölçekle", tone: "green" },
  ALERT: { label: "Uyarı", tone: "amber" },
};

const SEVERITY: Record<string, StatusStyle> = {
  INFO: { label: "Bilgi", tone: "blue" },
  WARNING: { label: "Uyarı", tone: "amber" },
  CRITICAL: { label: "Kritik", tone: "red" },
};

const ENTITY_STATUS: Record<string, StatusStyle> = {
  ACTIVE: { label: "Aktif", tone: "green" },
  PAUSED: { label: "Duraklatıldı", tone: "amber" },
  ARCHIVED: { label: "Arşiv", tone: "gray" },
  DRAFT: { label: "Taslak", tone: "gray" },
  DELETED: { label: "Silindi", tone: "red" },
};

function lookup(map: Record<string, StatusStyle>, key: string | null | undefined): StatusStyle {
  if (!key) return { label: "Bilinmiyor", tone: "gray" };
  return map[key] ?? { label: key, tone: "gray" };
}

export const approvalStyle = (key: string | null | undefined) => lookup(APPROVAL, key);
export const actionStyle = (key: string | null | undefined) => lookup(ACTION, key);
export const severityStyle = (key: string | null | undefined) => lookup(SEVERITY, key);
export const entityStatusStyle = (key: string | null | undefined) => lookup(ENTITY_STATUS, key);

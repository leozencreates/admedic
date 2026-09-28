/**
 * Geriye dönük uyumluluk: durum etiketleri artık tek kaynaktan (`labels.ts`, ADR-0016) gelir.
 * Yeni kod doğrudan `labels.ts`'i kullanmalı.
 */
export type { StatusStyle } from "./labels";
export { actionStyle, approvalStyle, entityStatusStyle, severityStyle } from "./labels";

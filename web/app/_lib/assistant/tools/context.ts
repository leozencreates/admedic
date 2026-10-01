/**
 * Araç uygulamalarının ortak bağlamı (ADR-0028). Tarayıcıya bağlı her şey (yönlendirici, `api()`, arama kutusu,
 * oturumu kapatma) dışarıdan verilir; araçlar böylece testte sahte bağımlılıklarla çalışır.
 */
import type { Role } from "@admedic/database";
import type { Language } from "../../i18n";
import type { RefMap } from "../ref-map";

/** `client-api.ts` `api()` imzası (aynı çerezli, aynı kaynaklı istek). */
export type ApiFn = <T>(url: string, method?: string, data?: unknown) => Promise<T>;

export interface ToolContext {
  role: Role;
  canApproveSpend: boolean;
  lang: Language;
  /** `useRouter()` (next/navigation) ya da eşdeğeri. */
  router: { push(href: string): void };
  api: ApiFn;
  refs: RefMap;
  /** Lead arama kutusunu açar (kabuk); verilmezse `/leads` açılır ve `ASSISTANT_OPEN_LEAD_SEARCH_EVENT` yayınlanır. */
  openLeadSearch?: () => void;
  /** Asistan oturumunu kapatır (`stop_assistant`). */
  stop?: () => void;
  /** Açık sayfanın yolu (`get_current_context`); verilmezse `window.location`. */
  location?: () => { pathname: string; search: string } | null;
  /** Konuşma boyunca tarayıcı belleğinde tutulan araç durumu (ajana gönderilmez). */
  memory: ToolMemory;
}

export interface ToolMemory {
  /** Son `generate_ad_copy` çıktısının tam içeriği (`save_studio_draft` bunu kaydeder); dondurulmuştur. */
  generatedCopy: Readonly<Record<string, unknown>> | null;
}

/**
 * Araç sonucu: ajana giden metin (JSON ya da kısa cümle). `entityId` yalnızca kendi denetim kaydımıza
 * (`/api/assistant/events`) gider, ajana hiçbir zaman gönderilmez.
 */
export interface ToolOutput {
  result: string;
  entityId?: string;
}

export type ToolHandler = (params: Record<string, unknown>, ctx: ToolContext) => Promise<ToolOutput>;

/** Okuma sonuçları tek satır JSON olarak döner (boş alanlar atlanır; ajan için daha kısa). */
export function json(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (v === null || v === undefined ? undefined : v));
}

/** Aracın kendi doğrulaması (ör. kayıp nedeni eksik); ileti ajana olduğu gibi gider (Türkçe, kimlik içermez). */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

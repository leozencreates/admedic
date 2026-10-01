/**
 * Sesle onay bekleyen eylem (ADR-0028 §2 "Onay mekanizması", Faz 3). R1 aracı işlemi hemen yapmaz: parametreleri
 * doğrular, buraya bir bekleyen eylem yazar ve ajana kısa bir özet + `pendingId` döner. İşlem ancak kullanıcı "evet"
 * deyip ajan `confirm_pending_action` çağırdığında ya da ekrandaki "Onayla"ya basıldığında, **bir kez** çalışır.
 *
 * Değişmezler:
 * - `pendingId` kriptografik rastgeledir (128 bit); tahmin edilemez, ajan uyduramaz.
 * - Parametreler oluşturma anında kopyalanır, derin dondurulur ve parmak izi alınır; sonradan değiştirilemez. Onayda
 *   parmak izi yeniden hesaplanır, uyuşmazsa çalıştırılmaz.
 * - Aynı anda yalnızca **bir** bekleyen eylem olur; yenisi eskisinin yerini alır (eski "replaced" ile biter).
 * - Süre risk seviyesine göre: R1 60 sn, R2/R3 120 sn (kullanıcı ekrandaki pencereyi okur; saat dışarıdan
 *   verilebilir). Süresi dolan, bilinmeyen ya da kullanılmış kimlik reddedilir (tekrar oynatma yok: kimlik
 *   çalıştırmadan önce tüketilir).
 * - Onay kaynakları (Faz 4): ajan yolu (`source: "agent"`, sözlü "evet") ve R1 onay kartı (`source: "card"`) yalnızca
 *   R1'i onaylar. R2/R3 hiçbir zaman sesle ya da kartla onaylanamaz; yalnızca ekrandaki modal onay penceresinde
 *   gerçek bir tıklama (`source: "ui"`) onaylar. R2/R3 eylemi ekranda gösterilecek yapılandırılmış bir onay görünümü
 *   (`confirmation`) taşımak zorundadır.
 * - Ajan yolunda ayrıca, eylem oluştuktan **sonra** kullanıcıdan gelmiş bir tur ve onun açık bir onay olması gerekir
 *   (`runtime.ts` `noteUserTurn` + `isAffirmativeReply`). Ajan kendi turunda, kullanıcı konuşmadan onaylayamaz.
 *
 * Saf modül (React yok); tarayıcı ve Node testlerinde aynı çalışır.
 */
import type { AssistantRisk } from "./events";

export const PENDING_TTL_MS = 60_000;

/** Risk seviyesine göre varsayılan onay süresi (ms). R2/R3: kullanıcı ekrandaki pencereyi okuyup tıklar. */
export const PENDING_TTL_BY_RISK: Readonly<Record<"R1" | "R2" | "R3", number>> = Object.freeze({
  R1: PENDING_TTL_MS,
  R2: 120_000,
  R3: 120_000,
});

/** `pendingId` biçimi: `p_` + 32 küçük onaltılık hane (128 bit). */
export const PENDING_ID_PATTERN = /^p_[0-9a-f]{32}$/;

/** Onaylanabilir risk seviyeleri (R0 doğrudan çalışır, bekleyen eylem olmaz). */
export type PendingRisk = Exclude<AssistantRisk, "R0">;

export type PendingEndReason = "confirmed" | "cancelled" | "expired" | "replaced";

/**
 * Onayı kim veriyor: ajan (sözlü "evet"), paneldeki R1 onay kartı ya da ekrandaki modal onay penceresi (R2/R3'ü
 * onaylayabilen tek yol).
 */
export type ConfirmSource = "agent" | "card" | "ui";

/** Yalnızca ekrandaki modal pencereden (`source: "ui"`) onaylanabilen risk seviyeleri. */
export const SCREEN_ONLY_RISKS: readonly PendingRisk[] = ["R2", "R3"];

/** Onay penceresindeki bir satır: alan adı ve (değişiyorsa) eski → yeni değer. Metinler biçimlendirilmiştir. */
export interface ConfirmationField {
  label: string;
  /** Eski değer; yoksa satır yalnızca `after` gösterir. */
  before?: string;
  after: string;
}

/**
 * R2/R3 onay penceresinin içeriği (ADR-0028 §2): başlık, kampanya adı, değişen alanlar (bütçe eski → yeni, para birimi
 * biçimli; durum eski → yeni), risk rozeti ve R3'te harcama uyarısı. Lead kişisel verisi içermez (lead yalnızca ref'le
 * anılır). Dondurulur; arayüz yalnızca okur.
 */
export interface ConfirmationView {
  title: string;
  /** Kampanya adı (lead kişisel verisi değildir; ekranda gösterilir). */
  campaignName?: string;
  fields: readonly ConfirmationField[];
  risk: "R2" | "R3";
  /** Risk rozeti metni. */
  riskLabel: string;
  /** R3: harcama uyarısı (sunucu ayrıca harcama yetkisini ve aylık tavanı denetler). */
  spendWarning?: string;
  /** Ek açıklamalar (ör. "Harcama başlamaz."). */
  notes?: readonly string[];
}

export type PendingErrorCode = "unknown" | "expired" | "consumed" | "not_confirmable" | "tampered" | "no_user_reply";

/** Ajana aktarılabilen tüm bekleyen eylem hata kodları (arayüzün bilinen iletiler listesi için). */
export const PENDING_ERROR_CODES: readonly PendingErrorCode[] = [
  "unknown",
  "expired",
  "consumed",
  "not_confirmable",
  "tampered",
  "no_user_reply",
];

const ERROR_MESSAGES: Record<PendingErrorCode, string> = {
  unknown: "Bekleyen bir işlem bulunamadı. İşlemi yeniden isteyin.",
  expired: "Onay süresi doldu; işlem yapılmadı. İsterseniz yeniden isteyin.",
  consumed: "Bu işlem zaten onaylandı ya da iptal edildi; tekrar çalıştırılmaz.",
  not_confirmable: "Bu işlem sesle onaylanamaz; kullanıcı ekrandaki onay penceresinden onaylamalı.",
  tampered: "İşlem parametreleri değişmiş; güvenlik için çalıştırılmadı. İşlemi yeniden isteyin.",
  no_user_reply:
    "Kullanıcı bu işlemi henüz açıkça onaylamadı; işlem yapılmadı. Özeti okuyun ve kullanıcının \"evet\" demesini bekleyin.",
};

/** Ret ya da duraksama bildiren sözcükler (tr + en); biri geçerse yanıt onay sayılmaz. */
const NEGATIVE_WORDS = new Set([
  "hayır", "hayir", "yok", "iptal", "vazgeç", "vazgeçtim", "vazgec", "dur", "durdur", "bekle", "yapma", "istemiyorum",
  "onaylamıyorum", "onaylama", "değil", "degil", "sonra", "no", "not", "cancel", "stop", "wait", "don't", "dont",
]);
/** Açık onay sözcükleri (tr + en). */
const AFFIRMATIVE_WORDS = new Set([
  "evet", "onaylıyorum", "onaylıyoruz", "onayla", "onaylayın", "onaylarım", "onay", "tamam", "olur", "peki", "kabul",
  "aynen", "tabii", "tabi", "elbette", "uygula", "yap", "yes", "yeah", "yep", "ok", "okay", "confirm", "confirmed", "sure",
]);

/**
 * Kullanıcının (yazıya dökülmüş) yanıtı açık bir onay mı? En az bir onay sözcüğü olmalı ve hiçbir ret sözcüğü
 * olmamalı. Bilinçli olarak gevşektir (sesli dökümde "Evet, onaylıyorum." gibi varyasyonlar); amaç ajanın kullanıcı
 * hiç "evet" demeden onaylamasını engellemektir, istemin yerine geçmek değil.
 */
export function isAffirmativeReply(text: string): boolean {
  const words = text
    .toLocaleLowerCase("tr")
    .replace(/[^\p{L}\p{N}']+/gu, " ")
    .split(" ")
    .filter(Boolean);
  if (!words.length || words.length > 12) return false;
  if (words.some((w) => NEGATIVE_WORDS.has(w))) return false;
  return words.some((w) => AFFIRMATIVE_WORDS.has(w));
}

/** Bekleyen eylem hatası; ileti ajana olduğu gibi gider (Türkçe, kimlik ve parametre içermez). */
export class PendingActionError extends Error {
  constructor(readonly code: PendingErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "PendingActionError";
  }
}

export type FrozenParams = Readonly<Record<string, unknown>>;

export interface PendingActionInput<R> {
  tool: string;
  risk: PendingRisk;
  /** Onaylanınca çalışacak parametreler; kopyalanıp dondurulur. Yalnızca JSON değerleri. */
  params: Record<string, unknown>;
  /** Kullanıcıya okunacak/gösterilecek kısa özet (kişisel veri içermez). */
  summary: string;
  /** Yalnızca denetim kaydı için (ajana gitmez). */
  entityId?: string;
  /** R2/R3 için zorunlu: ekrandaki onay penceresinin içeriği (kopyalanıp dondurulur). */
  confirmation?: ConfirmationView;
  /** Onayda tam bir kez, dondurulmuş parametrelerle çağrılır. */
  run: (params: FrozenParams) => Promise<R>;
}

/** Arayüzün (onay kartı) gördüğü hâl; parametreler ve `run` yoktur. */
export interface PendingView {
  pendingId: string;
  tool: string;
  risk: PendingRisk;
  summary: string;
  expiresAt: number;
  /** R2/R3: ekrandaki onay penceresinin içeriği (R1'de yok). */
  confirmation?: ConfirmationView;
}

export type PendingChange =
  | { type: "created"; pending: PendingView }
  | { type: "ended"; pending: PendingView; reason: PendingEndReason; entityId?: string };

interface Entry<R> {
  view: PendingView;
  params: FrozenParams;
  fingerprint: string;
  entityId?: string;
  run: (params: FrozenParams) => Promise<R>;
  timer?: unknown;
}

export interface PendingStoreOptions {
  now?: () => number;
  /** Tüm risk seviyeleri için tek süre (testler); verilmezse `PENDING_TTL_BY_RISK`. */
  ttlMs?: number;
  /** Risk seviyesine özel süre; `ttlMs`'den önce gelir. */
  ttlByRisk?: Partial<Record<PendingRisk, number>>;
  /** Test için; varsayılan `crypto.getRandomValues`. */
  randomBytes?: (n: number) => Uint8Array;
  /** Süre dolunca kartın kendiliğinden kapanması için; `false` verilirse zamanlayıcı kurulmaz (süre yine denetlenir). */
  timers?: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void } | false;
}

/** Kullanılmış kimlikler bu kadar tutulur ("zaten kullanıldı" iletisi için; aşılırsa "bulunamadı" döner). */
const CONSUMED_LIMIT = 200;

function defaultRandomBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

/** JSON değerlerini derin kopyalar; fonksiyon, sembol, döngü ve JSON dışı nesne reddedilir. */
function cloneJson(value: unknown, seen: Set<unknown> = new Set()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Bekleyen eylem parametresi sonlu bir sayı olmalı.");
    return value;
  }
  if (value === undefined) return undefined;
  if (typeof value !== "object") throw new TypeError("Bekleyen eylem parametresi JSON değeri olmalı.");
  if (seen.has(value)) throw new TypeError("Bekleyen eylem parametresi döngü içeremez.");
  seen.add(value);
  if (Array.isArray(value)) {
    const out = value.map((v) => cloneJson(v, seen));
    seen.delete(value);
    return out;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto !== Object.prototype && proto !== null) throw new TypeError("Bekleyen eylem parametresi düz nesne olmalı.");
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const c = cloneJson(v, seen);
    if (c !== undefined) out[k] = c;
  }
  seen.delete(value);
  return out;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/** Anahtarları sıralı JSON (aynı içerik → aynı metin). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** Eşzamanlı 2×32 bit FNV-1a parmak izi (kriptografik değil; dondurmaya ek bir bütünlük denetimi). */
export function fingerprint(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

function fingerprintOf(tool: string, risk: PendingRisk, params: unknown): string {
  return fingerprint(`${tool}\u0000${risk}\u0000${canonicalJson(params)}`);
}

export class PendingActionStore<R = unknown> {
  private current: Entry<R> | null = null;
  private readonly consumed = new Map<string, PendingEndReason>();
  private readonly listeners = new Set<(change: PendingChange) => void>();
  private readonly now: () => number;
  private readonly ttlMs: number | undefined;
  private readonly ttlByRisk: Partial<Record<PendingRisk, number>>;
  private readonly randomBytes: (n: number) => Uint8Array;
  private readonly timers: PendingStoreOptions["timers"];

  constructor(options: PendingStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs;
    this.ttlByRisk = options.ttlByRisk ?? {};
    this.randomBytes = options.randomBytes ?? defaultRandomBytes;
    this.timers =
      options.timers === undefined
        ? { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) }
        : options.timers;
  }

  /** Risk seviyesinin onay süresi (ms). */
  ttlFor(risk: PendingRisk): number {
    return this.ttlByRisk[risk] ?? this.ttlMs ?? PENDING_TTL_BY_RISK[risk];
  }

  /** Değişiklikleri dinler (onay kartı); dinleyiciden çıkış fonksiyonu döner. */
  onChange(listener: (change: PendingChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(change: PendingChange): void {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch {
        // Bir dinleyicinin hatası akışı bozmaz.
      }
    }
  }

  private newId(): string {
    const bytes = this.randomBytes(16);
    if (bytes.length !== 16) throw new Error("Rastgele kimlik üretilemedi.");
    return `p_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
  }

  private markConsumed(id: string, reason: PendingEndReason): void {
    this.consumed.set(id, reason);
    if (this.consumed.size > CONSUMED_LIMIT) this.consumed.delete(this.consumed.keys().next().value as string);
  }

  /** Mevcut eylemi bitirir (kimlik tüketilir, zamanlayıcı kapanır) ve olay yayınlar. */
  private end(reason: PendingEndReason): Entry<R> | null {
    const entry = this.current;
    if (!entry) return null;
    this.current = null;
    this.markConsumed(entry.view.pendingId, reason);
    if (entry.timer !== undefined && this.timers) this.timers.clear(entry.timer);
    this.emit({ type: "ended", pending: entry.view, reason, ...(entry.entityId ? { entityId: entry.entityId } : {}) });
    return entry;
  }

  /** Süresi dolmuşsa bitirir. Zamanlayıcı ve her erişim çağırır. */
  sweep(): void {
    if (this.current && this.now() >= this.current.view.expiresAt) this.end("expired");
  }

  create(input: PendingActionInput<R>): { pendingId: string; expiresAt: number } {
    if (!(["R1", "R2", "R3"] as string[]).includes(input.risk)) throw new TypeError("Yalnızca R1/R2/R3 araçları onay bekler.");
    if (SCREEN_ONLY_RISKS.includes(input.risk) && (!input.confirmation || input.confirmation.risk !== input.risk))
      throw new TypeError("R2/R3 eylemi, aynı risk seviyesinde bir ekran onay görünümü gerektirir.");
    const params = deepFreeze(cloneJson(input.params) as Record<string, unknown>);
    const confirmation = input.confirmation
      ? (deepFreeze(cloneJson(input.confirmation)) as ConfirmationView)
      : undefined;
    this.sweep();
    this.end("replaced");
    const pendingId = this.newId();
    const ttl = this.ttlFor(input.risk);
    const expiresAt = this.now() + ttl;
    const view: PendingView = Object.freeze({
      pendingId,
      tool: input.tool,
      risk: input.risk,
      summary: input.summary,
      expiresAt,
      ...(confirmation ? { confirmation } : {}),
    });
    const entry: Entry<R> = {
      view,
      params,
      fingerprint: fingerprintOf(input.tool, input.risk, params),
      entityId: input.entityId,
      run: input.run,
    };
    if (this.timers) entry.timer = this.timers.set(() => this.sweep(), ttl + 50);
    this.current = entry;
    this.emit({ type: "created", pending: view });
    return { pendingId, expiresAt };
  }

  /** Bekleyen eylem (süresi dolmamışsa). */
  get(): PendingView | null {
    this.sweep();
    return this.current?.view ?? null;
  }

  /** Bilinmeyen/süresi dolmuş/kullanılmış kimlik için hata kodu; geçerliyse `null`. */
  private check(pendingId: unknown): PendingErrorCode | null {
    this.sweep();
    if (typeof pendingId !== "string" || !PENDING_ID_PATTERN.test(pendingId)) return "unknown";
    if (this.current?.view.pendingId === pendingId) return null;
    const ended = this.consumed.get(pendingId);
    return ended === "expired" ? "expired" : ended ? "consumed" : "unknown";
  }

  /** Bekleyen eylemin özeti ve denetim bilgisi (çalıştırmadan); onay kartı ve olay kaydı için. */
  peek(pendingId: unknown): { view: PendingView; entityId?: string } | null {
    if (this.check(pendingId) !== null) return null;
    return { view: this.current!.view, ...(this.current!.entityId ? { entityId: this.current!.entityId } : {}) };
  }

  /**
   * Onaylar ve tam bir kez çalıştırır. Kimlik çalıştırmadan **önce** tüketilir: eşzamanlı ikinci onay ya da tekrar
   * oynatma `consumed` alır. Ajan yolu ve R1 kartı yalnızca R1 onaylar; R2/R3 yalnızca `source: "ui"` (ekrandaki modal
   * pencerede gerçek tıklama) ile çalışır. Reddedilen kaynakta eylem bekler (ekrandan onaylanabilir). Kaynak
   * verilmezse ajan yolu sayılır (en kısıtlı).
   */
  async confirm(pendingId: unknown, options: { source?: ConfirmSource } = {}): Promise<{ view: PendingView; entityId?: string; result: R }> {
    const code = this.check(pendingId);
    if (code) throw new PendingActionError(code);
    const entry = this.current!;
    const source = options.source ?? "agent";
    if (source !== "ui" && entry.view.risk !== "R1") throw new PendingActionError("not_confirmable");
    if (fingerprintOf(entry.view.tool, entry.view.risk, entry.params) !== entry.fingerprint) {
      this.end("cancelled");
      throw new PendingActionError("tampered");
    }
    this.end("confirmed");
    const result = await entry.run(entry.params);
    return { view: entry.view, ...(entry.entityId ? { entityId: entry.entityId } : {}), result };
  }

  /** İptal eder; bitirilen eylemin görünümü döner. Bilinmeyen/kullanılmış kimlikte hata. */
  cancel(pendingId: unknown): { view: PendingView; entityId?: string } {
    const code = this.check(pendingId);
    if (code) throw new PendingActionError(code);
    const entry = this.end("cancelled")!;
    return { view: entry.view, ...(entry.entityId ? { entityId: entry.entityId } : {}) };
  }

  /** Oturum kapanırken: bekleyen eylem iptal edilir ve dinleyiciler bırakılır. */
  dispose(): void {
    this.end("cancelled");
    this.listeners.clear();
  }
}

/**
 * Sesli asistan oturum bağdaştırıcısı (ADR-0028 §1, §4). Arayüz tek bir arabirimle çalışır:
 * - `ElevenLabsAdapter`: `@elevenlabs/react` `useConversation` denetimlerine bağlanır (kanca:
 *   `elevenlabs-adapter.ts` `useElevenLabsAdapter`). Bu modül SDK'yı çalışma anında içe aktarmaz.
 * - `MockAdapter`: ağ ve mikrofon olmadan, Türkçe kalıp cümleleri araç çağrılarına eşleyen senaryolu ajan. Deneme
 *   modunda (`/api/assistant/session` → `mock: true`) ve uçtan uca testlerde kullanılır.
 *
 * Saf modül (React yok); tarayıcı ve Node testlerinde aynı çalışır.
 */
import { NAV_ITEMS } from "../nav-tree";
import { t } from "../i18n";
import { findTool, pageKeyForHref } from "./registry";
import { TOOL_MESSAGES, type ClientToolFn } from "./runtime";

// ---------------------------------------------------------------- Ortak tipler

/** `POST /api/assistant/session` yanıtı. */
export interface AssistantSessionResponse {
  connection: "webrtc" | "websocket";
  conversationToken?: string;
  conversationId?: string;
  signedUrl?: string;
  serverLocation: string;
  mock: boolean;
  assistantName: string;
  language: "tr" | "en";
  voiceId: string | null;
  role: string;
  canApproveSpend: boolean;
}

export type SessionCredentials = Pick<
  AssistantSessionResponse,
  "connection" | "conversationToken" | "conversationId" | "signedUrl" | "serverLocation" | "mock"
>;

export type AdapterStatus = "disconnected" | "connecting" | "connected" | "disconnecting" | "error";
export type AdapterMode = "listening" | "speaking";

export interface AdapterMessage {
  role: "user" | "agent";
  text: string;
}

export interface AdapterEvents {
  status: (status: AdapterStatus, detail?: string) => void;
  mode: (mode: AdapterMode) => void;
  message: (message: AdapterMessage) => void;
  error: (message: string) => void;
  /** Konuşma kimliği belli olduğunda (denetim kaydı için). */
  connect: (conversationId: string | null) => void;
}

export interface StartOptions {
  credentials: SessionCredentials;
  clientTools: Record<string, ClientToolFn>;
  /** Ajanda Security sekmesinde açık olan geçersiz kılmalar: dil, ses, metin kipi (`docs/elevenlabs-constraints.md`). */
  overrides?: { language?: "tr" | "en"; voiceId?: string | null };
  /** Mikrofon yoksa ya da izin reddedildiyse: aynı ajan metinle (`sendUserMessage`). */
  textOnly?: boolean;
  /** Ajan istemindeki `{{…}}` değişkenleri (ör. asistan adı, izinli araçlar). */
  dynamicVariables?: Record<string, string | number | boolean>;
  /** Görünen asistan adı (ASSISTANT_NAME ?? APP_NAME; koda yazılmaz). Senaryolu ajan selamlamada kullanır. */
  assistantName?: string;
}

export interface VoiceSessionAdapter {
  readonly kind: "elevenlabs" | "mock";
  start(options: StartOptions): Promise<void>;
  end(): Promise<void>;
  sendUserMessage(text: string): void;
  sendContextualUpdate(text: string): void;
  getInputVolume(): number;
  getOutputVolume(): number;
  getStatus(): AdapterStatus;
  getMode(): AdapterMode;
  getConversationId(): string | null;
  on<K extends keyof AdapterEvents>(event: K, listener: AdapterEvents[K]): () => void;
}

/** Olay yayıcı ve durum tutan ortak taban. */
abstract class BaseAdapter {
  protected status: AdapterStatus = "disconnected";
  protected mode: AdapterMode = "listening";
  protected conversationId: string | null = null;
  private readonly listeners: { [K in keyof AdapterEvents]: Set<AdapterEvents[K]> } = {
    status: new Set(),
    mode: new Set(),
    message: new Set(),
    error: new Set(),
    connect: new Set(),
  };

  on<K extends keyof AdapterEvents>(event: K, listener: AdapterEvents[K]): () => void {
    this.listeners[event].add(listener);
    return () => {
      this.listeners[event].delete(listener);
    };
  }

  protected emit<K extends keyof AdapterEvents>(event: K, ...args: Parameters<AdapterEvents[K]>): void {
    for (const listener of this.listeners[event]) {
      try {
        (listener as (...a: Parameters<AdapterEvents[K]>) => void)(...args);
      } catch {
        // Bir dinleyicinin hatası diğerlerini durdurmaz.
      }
    }
  }

  protected setStatus(status: AdapterStatus, detail?: string): void {
    if (this.status === status && !detail) return;
    this.status = status;
    if (status === "disconnected") this.mode = "listening";
    this.emit("status", status, detail);
  }

  protected setMode(mode: AdapterMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.emit("mode", mode);
  }

  getStatus(): AdapterStatus {
    return this.status;
  }
  getMode(): AdapterMode {
    return this.mode;
  }
  getConversationId(): string | null {
    return this.conversationId;
  }
}

// ---------------------------------------------------------------- ElevenLabs

/**
 * `useConversation()` dönüşünün kullandığımız alt kümesi. `startSession` seçenekleri SDK'nın `HookOptions`'ına
 * yapısal olarak uyar; tip uyumu `elevenlabs-adapter.ts` içinde derleyiciyle denetlenir.
 */
export interface ElevenLabsControls {
  startSession: (options: ElevenLabsSessionOptions) => void;
  endSession: () => void;
  sendUserMessage: (text: string) => void;
  sendContextualUpdate: (text: string) => void;
  getInputVolume: () => number;
  getOutputVolume: () => number;
}

type ElevenLabsCommon = {
  serverLocation: string;
  clientTools: Record<string, ClientToolFn>;
  textOnly?: boolean;
  dynamicVariables?: Record<string, string | number | boolean>;
  overrides?: {
    agent?: { language?: "tr" | "en" };
    tts?: { voiceId?: string };
    conversation?: { textOnly?: boolean };
  };
};

export type ElevenLabsSessionOptions =
  | (ElevenLabsCommon & { conversationToken: string; connectionType: "webrtc" })
  | (ElevenLabsCommon & { signedUrl: string; connectionType: "websocket" });

/** Oturum yanıtı + seçenekler → SDK `startSession` seçenekleri (prompt ve ilk ileti bilerek geçersiz kılınmaz). */
export function toElevenLabsSessionOptions(options: StartOptions): ElevenLabsSessionOptions {
  const { credentials } = options;
  const overrides: ElevenLabsCommon["overrides"] = {
    ...(options.overrides?.language ? { agent: { language: options.overrides.language } } : {}),
    ...(options.overrides?.voiceId ? { tts: { voiceId: options.overrides.voiceId } } : {}),
    ...(options.textOnly ? { conversation: { textOnly: true } } : {}),
  };
  const common: ElevenLabsCommon = {
    serverLocation: credentials.serverLocation,
    clientTools: options.clientTools,
    ...(options.textOnly ? { textOnly: true } : {}),
    ...(options.dynamicVariables ? { dynamicVariables: options.dynamicVariables } : {}),
    ...(Object.keys(overrides).length ? { overrides } : {}),
  };
  if (credentials.connection === "webrtc") {
    if (!credentials.conversationToken) throw new Error("Oturum belirteci eksik.");
    return { ...common, conversationToken: credentials.conversationToken, connectionType: "webrtc" };
  }
  if (!credentials.signedUrl) throw new Error("Oturum adresi eksik.");
  return { ...common, signedUrl: credentials.signedUrl, connectionType: "websocket" };
}

/**
 * Ajan istemindeki dinamik değişkenler (`scripts/elevenlabs-sync-agent.ts` `ASSISTANT_DYNAMIC_VARIABLES`). Tarayıcı
 * oturumu başlatırken hepsini gönderir; aksi hâlde ajan eşitleme anındaki yer tutucuları (rol: VIEWER) kullanır.
 * Asistan adı koda yazılmaz: oturum yanıtındaki `assistantName` (ASSISTANT_NAME ?? APP_NAME), yoksa `fallbackName`.
 */
export function assistantDynamicVariables(
  session: Pick<AssistantSessionResponse, "assistantName" | "role">,
  fallbackName: string,
): { assistant_name: string; user_role: string } {
  return { assistant_name: session.assistantName || fallbackName, user_role: session.role };
}

/** Önceki oturumun SDK tarafında kapanmasını en çok bu kadar bekleriz; sonra kullanıcıya "tekrar dene" gösterilir. */
export const ELEVENLABS_DRAIN_TIMEOUT_MS = 10_000;

/**
 * ElevenLabs bağdaştırıcısı. SDK geri çağrıları `handle*` yöntemlerine, denetimler `bind` ile bağlanır
 * (`useElevenLabsAdapter`). `start` beklemez: bağlantı durumu `status` olaylarıyla gelir.
 *
 * Bağdaştırıcı oturumlar arasında paylaşılır. SDK, önceki bağlantı hâlâ kurulurken gelen `startSession`'ı sessizce
 * yok sayar; bu yüzden `end()` sonrası SDK "disconnected" diyene kadar bağdaştırıcı "boşalır": eski oturumun olayları
 * yeni dinleyicilere iletilmez ve `start` bu boşalmayı bekler (süre dolarsa hata verir; kullanıcı yeniden dener).
 */
export class ElevenLabsAdapter extends BaseAdapter implements VoiceSessionAdapter {
  readonly kind = "elevenlabs" as const;
  private controls: ElevenLabsControls | null = null;
  /** SDK'ya `startSession` verildi ve henüz "disconnected" bildirilmedi. */
  private sdkLive = false;
  private draining: { promise: Promise<void>; resolve: () => void } | null = null;

  constructor(private readonly options: { drainTimeoutMs?: number } = {}) {
    super();
  }

  bind(controls: ElevenLabsControls): void {
    this.controls = controls;
  }

  private finishDrain(): void {
    const drain = this.draining;
    this.draining = null;
    this.sdkLive = false;
    // Boşalma sırasında durum sessizce izlendi; yeni oturum temiz bir durumdan başlar.
    this.status = "disconnected";
    this.mode = "listening";
    drain?.resolve();
  }

  private async waitForDrain(): Promise<void> {
    const drain = this.draining;
    if (!drain) return;
    const timeoutMs = this.options.drainTimeoutMs ?? ELEVENLABS_DRAIN_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const drained = await Promise.race([
      drain.promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (!drained) {
      // Bir sonraki deneme beklemeden başlasın; bu deneme yok sayılmak yerine görünür biçimde başarısız olur.
      this.finishDrain();
      throw new Error("Önceki sesli oturum henüz kapanmadı.");
    }
  }

  async start(options: StartOptions): Promise<void> {
    if (!this.controls) throw new Error("Sesli asistan hazır değil.");
    if (options.credentials.mock) throw new Error("Deneme oturumu ElevenLabs'e bağlanamaz.");
    const sessionOptions = toElevenLabsSessionOptions(options);
    await this.waitForDrain();
    const controls = this.controls;
    this.conversationId = options.credentials.conversationId ?? null;
    this.setStatus("connecting");
    this.sdkLive = true;
    try {
      controls.startSession(sessionOptions);
    } catch (error) {
      this.sdkLive = false;
      this.setStatus("disconnected");
      throw error;
    }
  }

  async end(): Promise<void> {
    if (this.sdkLive && !this.draining) {
      let resolve: () => void = () => undefined;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      this.draining = { promise, resolve };
    }
    this.controls?.endSession();
  }

  sendUserMessage(text: string): void {
    if (this.draining) return;
    this.controls?.sendUserMessage(text);
  }
  sendContextualUpdate(text: string): void {
    if (this.draining) return;
    this.controls?.sendContextualUpdate(text);
  }
  getInputVolume(): number {
    return this.draining ? 0 : (this.controls?.getInputVolume() ?? 0);
  }
  getOutputVolume(): number {
    return this.draining ? 0 : (this.controls?.getOutputVolume() ?? 0);
  }

  handleConnect(conversationId: string | null): void {
    if (this.draining) return;
    if (conversationId) this.conversationId = conversationId;
    this.emit("connect", this.conversationId);
  }
  handleStatus(status: string): void {
    if (status !== "connecting" && status !== "connected" && status !== "disconnecting" && status !== "disconnected") return;
    if (this.draining) {
      // Kapanmakta olan eski oturum: olay yeni dinleyicilere gitmez.
      if (status === "disconnected") this.finishDrain();
      return;
    }
    if (status === "disconnected") this.sdkLive = false;
    this.setStatus(status);
  }
  handleMode(mode: string): void {
    if (this.draining) return;
    if (mode === "speaking" || mode === "listening") this.setMode(mode);
  }
  handleMessage(role: string, text: string): void {
    if (this.draining) return;
    this.emit("message", { role: role === "user" ? "user" : "agent", text });
  }
  /**
   * SDK `onError`. Bağlantı kurulduktan sonraki hatalar (ör. tanımsız istemci aracı, ajan kapanışındaki uyarılar, MCP
   * bildirimleri) oturumu bitirmez; bağlantı gerçekten koparsa SDK ayrıca "disconnected" bildirir. Yalnızca bağlantı
   * kurulmadan gelen hata ölümcüldür. Ham ileti kullanıcıya gösterilmez.
   */
  handleError(message: string): void {
    if (this.draining) return;
    if (this.status === "connected") return;
    this.setStatus("error", message);
    this.emit("error", message);
  }
}

// ---------------------------------------------------------------- Senaryolu (mock) ajan

/** Komut: kalıp → araç adı ve parametreleri. Sıra önemlidir (özel kalıp önce). */
interface ScriptRule {
  pattern: RegExp;
  tool: string;
  params?: (text: string) => Record<string, unknown>;
}

function normalize(text: string): string {
  return text
    .toLocaleLowerCase("tr")
    .replace(/[’']/g, "")
    .replace(/[.,!?;:"]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Menü adı → sayfa anahtarı ("uyarılar sayfasına git"). Uzun adlar önce eşleşir. */
const PAGE_NAMES: { name: string; key: string }[] = NAV_ITEMS.flatMap((item) =>
  (["tr", "en"] as const).map((lang) => ({ name: normalize(t(item.key, lang)), key: pageKeyForHref(item.href) })),
).sort((a, b) => b.name.length - a.name.length);

const ORDINALS: Record<string, number> = { ilk: 1, birinci: 1, ikinci: 2, üçüncü: 3, dördüncü: 4, beşinci: 5 };

function ordinalRef(prefix: string, text: string): string {
  const word = Object.keys(ORDINALS).find((w) => text.includes(w));
  const digits = /\b(\d{1,3})\b/.exec(text)?.[1];
  return `${prefix}${word ? ORDINALS[word] : digits ? Number(digits) : 1}`;
}

export const MOCK_SCRIPT: readonly ScriptRule[] = [
  { pattern: /(kapat|görüşürüz|bu kadar|teşekkürler)/, tool: "stop_assistant" },
  // Faz 4 araçları (R3/R2): kayıtta yok → "desteklenmiyor" yanıtı; kayda girince aynı kalıp çalışır.
  { pattern: /kampanyay[ıi] (aktifleştir|etkinleştir|başlat)/, tool: "activate_campaign", params: (s) => ({ ref: ordinalRef("c", s) }) },
  { pattern: /yeni kampanya/, tool: "open_new_campaign_planner" },
  { pattern: /(lead|hasta).*(ara|bul)|arama kutusu/, tool: "open_lead_search" },
  { pattern: /onay(lar|lara|ları)? ?(git|aç|göster)?$|onaylara/, tool: "open_approvals" },
  {
    pattern: /kampanyay[ıi] aç|kampanyas[ıi]n[ıi] aç/,
    tool: "open_campaign",
    params: (s) => ({ ref: ordinalRef("c", s) }),
  },
  { pattern: /lead(i|ini)? aç/, tool: "open_lead", params: (s) => ({ ref: ordinalRef("l", s) }) },
  { pattern: /(kampanya.*(detay|ayrıntı|nasıl))/, tool: "get_campaign", params: (s) => ({ ref: ordinalRef("c", s) }) },
  { pattern: /bugün|günün özeti|ne var/, tool: "get_today_summary" },
  { pattern: /haftalık rapor/, tool: "get_weekly_report_summary" },
  { pattern: /bekleyen lead|çekilemeyen/, tool: "pending_leads_count" },
  { pattern: /lead|hasta adayı/, tool: "get_lead_stats" },
  { pattern: /uyarı/, tool: "list_alerts" },
  { pattern: /öneri/, tool: "list_recommendations" },
  { pattern: /karar/, tool: "list_decisions" },
  { pattern: /politika|bütçe sınır/, tool: "get_policy_status" },
  { pattern: /abonelik|planım/, tool: "get_subscription" },
  { pattern: /performans|içgörü|harcama/, tool: "get_insights" },
  { pattern: /kampanya/, tool: "list_campaigns" },
];

/** Metin → araç çağrısı; "X sayfasına git" menü adlarından çözülür. Eşleşme yoksa `null`. */
export function matchMockCommand(text: string): { tool: string; params: Record<string, unknown> } | null {
  const s = normalize(text);
  if (!s) return null;
  if (/(sayfa|git|aç|göster)/.test(s)) {
    const page = PAGE_NAMES.find((p) => p.name && s.includes(p.name) && /(sayfa|git)/.test(s));
    if (page) return { tool: "navigate_to", params: { pageKey: page.key } };
  }
  for (const rule of MOCK_SCRIPT) if (rule.pattern.test(s)) return { tool: rule.tool, params: rule.params?.(s) ?? {} };
  return null;
}

function parse(result: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(result);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Araç sonucu → kısa Türkçe yanıt (gerçek ajanın yerine; yalnızca sayılar ve durumlar). */
export function mockReply(tool: string, result: string): string {
  const data = parse(result);
  if (!data) return result;
  if (data.ok === false) return String(data.error ?? TOOL_MESSAGES.failed);
  const n = (v: unknown) => (typeof v === "number" ? v : 0);
  switch (tool) {
    case "get_today_summary":
      return `Bugün ${n(data.pendingApprovals)} onay, ${n(data.leadsAwaitingReply)} yanıt bekleyen lead ve ${n(data.openAlerts)} açık uyarı var.`;
    case "list_campaigns":
      return n(data.total) ? `${n(data.total)} kampanya var. İlk ${n(data.shown)} tanesini listeledim.` : "Hiç kampanya yok.";
    case "get_campaign": {
      const c = (data.campaign ?? {}) as Record<string, unknown>;
      return `${String(c.name ?? "Kampanya")}: durum ${String(c.workflowStatus ?? "bilinmiyor")}.`;
    }
    case "list_alerts":
      return n(data.total) ? `${n(data.total)} uyarı var.` : "Uyarı yok.";
    case "list_recommendations":
      return n(data.total) ? `${n(data.total)} öneri var.` : "Öneri yok.";
    case "list_decisions":
      return n(data.total) ? `${n(data.total)} ajan kararı var; ${n(data.pendingApproval)} tanesi onay bekliyor.` : "Ajan kararı yok.";
    case "get_lead_stats":
      return `${n(data.total)} lead var; ${n(data.awaitingReply)} tanesi yanıt bekliyor.`;
    case "pending_leads_count":
      return `${n(data.pending)} lead'in alanları henüz çekilemedi.`;
    case "get_insights": {
      const s = (data.summary ?? {}) as Record<string, unknown>;
      return `Son 30 günde ${n(s.leads)} lead geldi.`;
    }
    case "get_weekly_report_summary": {
      const s = (data.summary ?? {}) as Record<string, unknown>;
      return `Geçen hafta ${n(s.totalLeads)} lead geldi.`;
    }
    case "get_policy_status":
      return data.configured ? "Optimizasyon politikası tanımlı." : "Optimizasyon politikası tanımlı değil.";
    case "get_subscription": {
      const s = data.subscription as Record<string, unknown> | undefined;
      return s ? `Planınız ${String(s.plan)}, durum ${String(s.status)}.` : "Abonelik bulunamadı.";
    }
    case "stop_assistant":
      return "Görüşmek üzere.";
    default:
      return "Tamam.";
  }
}

export const MOCK_MESSAGES = {
  greeting: (name?: string) => (name ? `${name} burada. Size nasıl yardımcı olabilirim?` : "Size nasıl yardımcı olabilirim?"),
  unknown: "Bunu anlayamadım. Örneğin \"kampanyaları göster\" ya da \"onaylara git\" diyebilirsiniz.",
  unsupported: "Bu komut henüz desteklenmiyor.",
} as const;

/**
 * Senaryolu ajan: ağ ve mikrofon kullanmaz. Kullanıcı metnini (`sendUserMessage`) kalıplarla araç çağrısına çevirir,
 * gerçek `clientTools` işleyicisini çalıştırır (böylece rol süzgeci, ref'ler, temizleme ve denetim kaydı gerçek yoldan
 * geçer) ve kısa bir Türkçe yanıt yayınlar. Ses seviyesi konuşurken sabit bir değer döner (orb animasyonu için).
 */
export class MockAdapter extends BaseAdapter implements VoiceSessionAdapter {
  readonly kind = "mock" as const;
  private tools: Record<string, ClientToolFn> = {};
  private pending: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(private readonly options: { delayMs?: number } = {}) {
    super();
  }

  private wait(): Promise<void> {
    const ms = this.options.delayMs ?? 300;
    return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
  }

  async start(options: StartOptions): Promise<void> {
    this.tools = options.clientTools;
    this.stopped = false;
    this.conversationId = options.credentials.conversationId ?? null;
    this.setStatus("connecting");
    await this.wait();
    this.setStatus("connected");
    this.emit("connect", this.conversationId);
    this.say(MOCK_MESSAGES.greeting(options.assistantName));
  }

  async end(): Promise<void> {
    this.stopped = true;
    if (this.status === "disconnected") return;
    this.setStatus("disconnecting");
    this.setStatus("disconnected");
  }

  /** Kullanıcı turu; yanıtlar sırayla işlenir. Tamamlanınca çözülen söz (testler için). */
  sendUserMessage(text: string): Promise<void> {
    if (this.status !== "connected") return this.pending;
    this.emit("message", { role: "user", text });
    this.pending = this.pending.then(() => this.respond(text));
    return this.pending;
  }

  sendContextualUpdate(): void {
    // Senaryolu ajan bağlamı kullanmaz.
  }

  getInputVolume(): number {
    return this.status === "connected" && this.mode === "listening" ? 0.2 : 0;
  }
  getOutputVolume(): number {
    return this.mode === "speaking" ? 0.6 : 0;
  }

  private say(text: string): void {
    if (this.stopped) return;
    this.setMode("speaking");
    this.emit("message", { role: "agent", text });
    this.setMode("listening");
  }

  private async respond(text: string): Promise<void> {
    const command = matchMockCommand(text);
    if (!command) return this.say(MOCK_MESSAGES.unknown);
    const fn = this.tools[command.tool];
    if (!fn) return this.say(findTool(command.tool) ? TOOL_MESSAGES.forbidden : MOCK_MESSAGES.unsupported);
    await this.wait();
    const result = await fn(command.params);
    this.say(mockReply(command.tool, result));
  }
}

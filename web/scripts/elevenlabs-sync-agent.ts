/**
 * Sesli komut asistanının ElevenLabs ajan yapılandırmasını koddan eşitler (ADR-0028 §1, §7;
 * docs/elevenlabs-constraints.md "Ajan yapılandırmasını koddan eşitleme").
 *
 * 1. Araç kaydındaki (`app/_lib/assistant/registry.ts`) her istemci aracı ada göre eşlenir:
 *    yoksa `POST /v1/convai/tools`, farklıysa `PATCH /v1/convai/tools/{tool_id}`, aynıysa dokunulmaz.
 * 2. Ajan `PATCH /v1/convai/agents/{agent_id}` ile güncellenir: prompt, LLM, dil `tr`, TTS `eleven_flash_v2_5`,
 *    `prompt.tool_ids` (kullanım dışı `prompt.tools` kullanılmaz).
 *
 * LLM varsayılanı yoktur (ADR-0013 §2, ADR-0028 §7): `--llm` verilmezse betik çalışmaz.
 * `--dry-run` (ya da ELEVENLABS_API_KEY yoksa / META_MOCK_MODE=true ise) ağa çıkmadan gövdeleri yazdırır.
 * API anahtarı hiçbir koşulda yazdırılmaz.
 *
 * Kullanım: pnpm --filter @admedic/web assistant:sync-agent -- --llm <model> [--dry-run]
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { toElevenLabsToolConfigs, type ElevenLabsClientToolConfig } from "../app/_lib/assistant/registry";

export const ASSISTANT_LANGUAGE = "tr";
export const ASSISTANT_TTS_MODEL = "eleven_flash_v2_5";
/** Prompt'taki dinamik değişkenler; tarayıcı oturumu başlatırken `dynamicVariables` ile hepsini göndermelidir. */
export const ASSISTANT_DYNAMIC_VARIABLES = ["assistant_name", "user_role"] as const;
/** Depodaki prompt dosyası (bu dosyaya göre). */
export const PROMPT_RELATIVE_PATH = "../../packages/voice/agent/assistant.prompt.tr.md";

const LLM_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,79}$/;
const REQUEST_TIMEOUT_MS = 20_000;

export interface SyncArgs {
  llm: string;
  dryRun: boolean;
}

export class SyncUsageError extends Error {}

const USAGE =
  "Kullanım: assistant:sync-agent --llm <model> [--dry-run]\n" +
  "  --llm      Ajanın LLM'i (zorunlu; varsayılan yok, ADR-0028 §7). Örn. ElevenLabs LLM listesindeki bir değer.\n" +
  "  --dry-run  Ağa çıkmadan gönderilecek gövdeleri yazdırır (ELEVENLABS_API_KEY yoksa kendiliğinden).";

export function parseArgs(argv: readonly string[]): SyncArgs {
  let llm: string | undefined;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--llm") llm = argv[++i];
    else if (arg.startsWith("--llm=")) llm = arg.slice("--llm=".length);
    else if (arg === "--help" || arg === "-h") throw new SyncUsageError(USAGE);
    else throw new SyncUsageError(`Bilinmeyen argüman: ${arg}\n${USAGE}`);
  }
  llm = llm?.trim();
  if (!llm) throw new SyncUsageError(`--llm zorunludur; ajanın LLM'i açıkça seçilmelidir (ADR-0028 §7).\n${USAGE}`);
  if (!LLM_PATTERN.test(llm)) throw new SyncUsageError(`Geçersiz --llm değeri: ${llm}`);
  return { llm, dryRun };
}

export interface AgentPatchInput {
  prompt: string;
  llm: string;
  toolIds: readonly string[];
  assistantName: string;
}

/** `PATCH /v1/convai/agents/{agent_id}` gövdesi (OpenAPI `Body_Patches_an_Agent_settings…`, 2026-10-01). */
export function buildAgentPatch(input: AgentPatchInput) {
  return {
    conversation_config: {
      agent: {
        language: ASSISTANT_LANGUAGE,
        // Panelde "test" konuşmaları için yer tutucular; gerçek oturumda tarayıcı değerleri gönderir.
        dynamic_variables: {
          dynamic_variable_placeholders: { assistant_name: input.assistantName, user_role: "VIEWER" },
        },
        prompt: { prompt: input.prompt, llm: input.llm, tool_ids: [...input.toolIds] },
      },
      tts: { model_id: ASSISTANT_TTS_MODEL },
    },
  };
}

export interface ElevenLabsToolRecord {
  id: string;
  tool_config: { type?: string; name?: string } & Record<string, unknown>;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface SyncOptions {
  llm: string;
  prompt: string;
  assistantName: string;
  dryRun: boolean;
  apiBase: string;
  apiKey?: string;
  agentId?: string;
  tools?: ElevenLabsClientToolConfig[];
  fetch?: FetchLike;
  log?: (line: string) => void;
}

export interface SyncResult {
  dryRun: boolean;
  created: string[];
  updated: string[];
  unchanged: string[];
  toolIds: string[];
  agentPatch: ReturnType<typeof buildAgentPatch>;
}

function isDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => isDeepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** Uzak araç, istenen yapılandırmanın her alanını aynı değerle taşıyor mu? (Sunucunun eklediği varsayılanlar yok sayılır.) */
export function toolMatches(remote: Record<string, unknown>, desired: ElevenLabsClientToolConfig): boolean {
  if (!desired.parameters && remote.parameters != null) return false;
  return Object.entries(desired).every(([key, value]) => isDeepEqual(remote[key], value));
}

export async function syncAgent(options: SyncOptions): Promise<SyncResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const tools = options.tools ?? toElevenLabsToolConfigs();
  const names = tools.map((t) => t.name);
  if (new Set(names).size !== names.length) throw new Error("Araç kaydında yinelenen ad var.");

  if (options.dryRun) {
    const toolIds = names.map((name) => `<tool_id:${name}>`);
    const agentPatch = buildAgentPatch({ ...options, toolIds });
    log("[dry-run] Ağa istek gönderilmedi.");
    log(`[dry-run] ${tools.length} istemci aracı (POST /v1/convai/tools ya da PATCH /v1/convai/tools/{tool_id}):`);
    log(JSON.stringify(tools.map((tool_config) => ({ tool_config })), null, 2));
    log(`[dry-run] PATCH /v1/convai/agents/${options.agentId ?? "<ELEVENLABS_ASSISTANT_AGENT_ID>"}:`);
    log(JSON.stringify(agentPatch, null, 2));
    return { dryRun: true, created: [], updated: [], unchanged: [], toolIds, agentPatch };
  }

  if (!options.apiKey) throw new Error("ELEVENLABS_API_KEY ayarlanmadı.");
  if (!options.agentId) throw new Error("ELEVENLABS_ASSISTANT_AGENT_ID ayarlanmadı.");
  const doFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const base = options.apiBase.replace(/\/+$/, "");
  const apiKey = options.apiKey;

  async function call<T>(method: string, pathname: string, body?: unknown): Promise<T> {
    const res = await doFetch(`${base}${pathname}`, {
      method,
      headers: { "xi-api-key": apiKey, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 500);
      throw new Error(`ElevenLabs ${method} ${pathname} → ${res.status}${text ? `: ${text}` : ""}`);
    }
    return (await res.json()) as T;
  }

  // Mevcut istemci araçları (sayfalı).
  const remote = new Map<string, ElevenLabsToolRecord[]>();
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const query = new URLSearchParams({ types: "client", page_size: "100" });
    if (cursor) query.set("cursor", cursor);
    const data = await call<{ tools: ElevenLabsToolRecord[]; has_more: boolean; next_cursor?: string | null }>(
      "GET",
      `/v1/convai/tools?${query}`,
    );
    for (const record of data.tools ?? []) {
      const name = record.tool_config?.name;
      if (record.tool_config?.type !== "client" || !name) continue;
      remote.set(name, [...(remote.get(name) ?? []), record]);
    }
    if (!data.has_more || !data.next_cursor) break;
    cursor = data.next_cursor;
  }

  const created: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];
  const toolIds: string[] = [];
  for (const tool of tools) {
    const matches = remote.get(tool.name) ?? [];
    if (matches.length > 1)
      throw new Error(
        `"${tool.name}" adlı birden fazla istemci aracı var (${matches.map((m) => m.id).join(", ")}); fazlalığı panelden silin.`,
      );
    const existing = matches[0];
    if (!existing) {
      const res = await call<{ id: string }>("POST", "/v1/convai/tools", { tool_config: tool });
      toolIds.push(res.id);
      created.push(tool.name);
      log(`+ ${tool.name} oluşturuldu`);
    } else if (toolMatches(existing.tool_config, tool)) {
      toolIds.push(existing.id);
      unchanged.push(tool.name);
      log(`= ${tool.name} aynı`);
    } else {
      await call("PATCH", `/v1/convai/tools/${encodeURIComponent(existing.id)}`, { tool_config: tool });
      toolIds.push(existing.id);
      updated.push(tool.name);
      log(`~ ${tool.name} güncellendi`);
    }
  }

  const agentPatch = buildAgentPatch({ ...options, toolIds });
  const agent = await call<{ conversation_config?: { agent?: { prompt?: { tool_ids?: string[]; llm?: string } } } }>(
    "PATCH",
    `/v1/convai/agents/${encodeURIComponent(options.agentId)}`,
    agentPatch,
  );
  // PATCH'in tool_ids'i birleştirmek yerine değiştirdiği canlıda doğrulanmadı; yanıttan denetlenir.
  const remotePrompt = agent.conversation_config?.agent?.prompt;
  const remoteIds = [...(remotePrompt?.tool_ids ?? [])].sort();
  if (!isDeepEqual(remoteIds, [...toolIds].sort()) || remotePrompt?.llm !== options.llm)
    throw new Error(
      "Ajan güncellendi ama yanıttaki tool_ids/llm beklenenle aynı değil; ajanı panelden denetleyin (docs/elevenlabs-constraints.md).",
    );
  log(`Ajan güncellendi: ${toolIds.length} araç, llm=${options.llm}, dil=${ASSISTANT_LANGUAGE}, tts=${ASSISTANT_TTS_MODEL}.`);
  return { dryRun: false, created, updated, unchanged, toolIds, agentPatch };
}

export function readPrompt(file = path.resolve(__dirname, PROMPT_RELATIVE_PATH)): string {
  const text = readFileSync(file, "utf8").replace(/^﻿/, "").trim();
  if (!text) throw new Error(`Prompt dosyası boş: ${file}`);
  return text;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { loadEnv } = await import("@admedic/config");
  const env = loadEnv();
  const forcedDryRun = !env.ELEVENLABS_API_KEY || env.META_MOCK_MODE;
  if (forcedDryRun && !args.dryRun)
    console.log(
      env.META_MOCK_MODE
        ? "META_MOCK_MODE=true: dışarı istek gönderilmez, dry-run çalışılıyor."
        : "ELEVENLABS_API_KEY yok: dry-run çalışılıyor.",
    );
  await syncAgent({
    llm: args.llm,
    prompt: readPrompt(),
    assistantName: env.ASSISTANT_NAME ?? env.APP_NAME,
    dryRun: args.dryRun || forcedDryRun,
    apiBase: env.ELEVENLABS_API_BASE,
    apiKey: env.ELEVENLABS_API_KEY,
    agentId: env.ELEVENLABS_ASSISTANT_AGENT_ID,
  });
}

if (/elevenlabs-sync-agent\.[cm]?[jt]s$/.test(process.argv[1] ?? "")) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Eşitleme tamamlanamadı.");
    process.exitCode = 1;
  });
}

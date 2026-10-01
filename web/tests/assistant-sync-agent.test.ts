import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ASSISTANT_TOOLS, toElevenLabsToolConfigs } from "../app/_lib/assistant/registry";
import { assistantDynamicVariables, toElevenLabsSessionOptions } from "../app/_lib/assistant/adapter";
import {
  ASSISTANT_DYNAMIC_VARIABLES,
  ASSISTANT_TTS_MODEL,
  buildAgentPatch,
  parseArgs,
  readPrompt,
  SyncUsageError,
  syncAgent,
  toolMatches,
} from "../scripts/elevenlabs-sync-agent";

const PROMPT_FILE = fileURLToPath(new URL("../../packages/voice/agent/assistant.prompt.tr.md", import.meta.url));
const registryNames = ASSISTANT_TOOLS.map((t) => t.name);

afterEach(() => vi.unstubAllGlobals());

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("elevenlabs-sync-agent: argümanlar", () => {
  it("--llm olmadan çalışmaz (varsayılan LLM yok)", () => {
    expect(() => parseArgs([])).toThrow(SyncUsageError);
    expect(() => parseArgs(["--dry-run"])).toThrow(/--llm zorunludur/);
    expect(() => parseArgs(["--llm", "  "])).toThrow(/--llm zorunludur/);
  });

  it("--llm ve --dry-run okunur; bilinmeyen argüman reddedilir", () => {
    expect(parseArgs(["--", "--llm", "model-x", "--dry-run"])).toEqual({ llm: "model-x", dryRun: true });
    expect(parseArgs(["--llm=model-y"])).toEqual({ llm: "model-y", dryRun: false });
    expect(() => parseArgs(["--llm", "a b"])).toThrow(/Geçersiz/);
    expect(() => parseArgs(["--llm", "x", "--agent", "y"])).toThrow(/Bilinmeyen/);
  });
});

describe("elevenlabs-sync-agent: dry-run", () => {
  it("ağa çıkmaz ve araç adları kayıttakiyle birebir aynıdır", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetchSpy);
    const lines: string[] = [];
    const result = await syncAgent({
      llm: "model-x",
      prompt: "p",
      assistantName: "Asistan",
      dryRun: true,
      apiBase: "https://api.elevenlabs.io",
      apiKey: "sk_secret_value",
      agentId: "agent_1",
      fetch: fetchSpy,
      log: (line) => lines.push(line),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.dryRun).toBe(true);

    const output = lines.join("\n");
    expect(output).not.toContain("sk_secret_value");
    const printedTools = JSON.parse(lines[2]) as { tool_config: { name: string; type: string } }[];
    // Büyük/küçük harfe duyarlı, sıra dahil birebir eşleşme.
    expect(printedTools.map((t) => t.tool_config.name)).toStrictEqual(registryNames);
    expect(printedTools.every((t) => t.tool_config.type === "client")).toBe(true);
    expect(result.toolIds).toStrictEqual(registryNames.map((n) => `<tool_id:${n}>`));
    expect(result.agentPatch.conversation_config.agent.prompt.tool_ids).toHaveLength(registryNames.length);
  });
});

describe("elevenlabs-sync-agent: canlı akış (sahte fetch)", () => {
  it("araçları ada göre eşler: aynı olanı atlar, farklıyı günceller, olmayanı oluşturur; ajanı tool_ids ile PATCH'ler", async () => {
    const configs = toElevenLabsToolConfigs();
    const [same, changed] = configs;
    const calls: { method: string; url: string; body?: unknown; key?: string }[] = [];
    let n = 0;
    const fakeFetch = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body, key: (init?.headers as Record<string, string>)["xi-api-key"] });
      if (method === "GET")
        return jsonResponse({
          tools: [
            { id: "t_same", tool_config: { ...same, disable_interruptions: false } },
            { id: "t_changed", tool_config: { ...changed, description: "eski" } },
            { id: "t_other", tool_config: { type: "webhook", name: "navigate_to" } },
          ],
          has_more: false,
        });
      if (method === "POST") return jsonResponse({ id: `t_new_${++n}` });
      if (url.includes("/v1/convai/tools/")) return jsonResponse({ id: "t_changed" });
      return jsonResponse({
        conversation_config: { agent: { prompt: { tool_ids: body.conversation_config.agent.prompt.tool_ids, llm: "model-x" } } },
      });
    });

    const result = await syncAgent({
      llm: "model-x",
      prompt: "p",
      assistantName: "Asistan",
      dryRun: false,
      apiBase: "https://api.example.test/",
      apiKey: "sk_secret_value",
      agentId: "agent_1",
      fetch: fakeFetch,
      log: () => {},
    });

    expect(result.unchanged).toEqual([same.name]);
    expect(result.updated).toEqual([changed.name]);
    expect(result.created).toEqual(configs.slice(2).map((c) => c.name));
    expect(calls.every((c) => c.key === "sk_secret_value" && c.url.startsWith("https://api.example.test/v1/convai/"))).toBe(true);

    const posted = calls.filter((c) => c.method === "POST").map((c) => (c.body as { tool_config: { name: string } }).tool_config.name);
    expect(posted).toStrictEqual(configs.slice(2).map((c) => c.name));

    const agentCall = calls.find((c) => c.url.endsWith("/v1/convai/agents/agent_1"));
    expect(agentCall?.method).toBe("PATCH");
    const patch = agentCall?.body as ReturnType<typeof buildAgentPatch>;
    expect(patch.conversation_config.agent.prompt.tool_ids).toStrictEqual(result.toolIds);
    expect(patch.conversation_config.agent.prompt.tool_ids.slice(0, 2)).toEqual(["t_same", "t_changed"]);
    expect(patch.conversation_config.agent.prompt).not.toHaveProperty("tools");
  });

  it("aynı adlı iki istemci aracı varsa durur", async () => {
    const [first] = toElevenLabsToolConfigs();
    const fakeFetch = vi.fn(async () =>
      jsonResponse({
        tools: [
          { id: "a", tool_config: first },
          { id: "b", tool_config: first },
        ],
        has_more: false,
      }),
    );
    await expect(
      syncAgent({
        llm: "m", prompt: "p", assistantName: "A", dryRun: false, apiBase: "https://x.test", apiKey: "k", agentId: "g",
        fetch: fakeFetch, log: () => {},
      }),
    ).rejects.toThrow(/birden fazla/);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it("toolMatches parametre kaldırılmasını fark eder", () => {
    const noParams = toElevenLabsToolConfigs().find((c) => !c.parameters)!;
    expect(toolMatches({ ...noParams }, noParams)).toBe(true);
    expect(toolMatches({ ...noParams, parameters: { type: "object", properties: {}, required: [] } }, noParams)).toBe(false);
  });
});

describe("ajan yapılandırması", () => {
  it("PATCH gövdesi dil, TTS modeli, LLM ve yer tutucuları taşır", () => {
    const patch = buildAgentPatch({ prompt: "p", llm: "model-x", toolIds: ["t1"], assistantName: "Asistan" });
    expect(patch.conversation_config.agent.language).toBe("tr");
    expect(patch.conversation_config.tts.model_id).toBe(ASSISTANT_TTS_MODEL);
    expect(patch.conversation_config.agent.prompt).toEqual({ prompt: "p", llm: "model-x", tool_ids: ["t1"] });
    expect(Object.keys(patch.conversation_config.agent.dynamic_variables.dynamic_variable_placeholders).sort()).toEqual(
      [...ASSISTANT_DYNAMIC_VARIABLES].sort(),
    );
  });

  it("prompt dinamik değişkenleri kullanır, uygulama adını içermez ve yalnızca kayıttaki araçları anar", () => {
    const prompt = readPrompt(PROMPT_FILE);
    const vars = [...prompt.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)].map((m) => m[1]);
    expect(new Set(vars)).toEqual(new Set(ASSISTANT_DYNAMIC_VARIABLES));
    expect(prompt.toLowerCase()).not.toContain("admedic");
    const mentioned = [...prompt.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1]);
    expect(mentioned.length).toBeGreaterThan(0);
    for (const name of mentioned) expect(registryNames).toContain(name);
    expect(readFileSync(PROMPT_FILE, "utf8")).toContain("{{assistant_name}}");
  });
});

describe("tarayıcı oturumu dinamik değişkenleri", () => {
  it("istemdeki her değişkeni gönderir; ad oturum yanıtından, yoksa uygulama adından gelir", () => {
    const vars = assistantDynamicVariables({ assistantName: "Asistan", role: "MEDIA_BUYER" }, "Uygulama");
    expect(Object.keys(vars).sort()).toEqual([...ASSISTANT_DYNAMIC_VARIABLES].sort());
    expect(vars).toEqual({ assistant_name: "Asistan", user_role: "MEDIA_BUYER" });
    expect(assistantDynamicVariables({ assistantName: "", role: "VIEWER" }, "Uygulama").assistant_name).toBe("Uygulama");
    const options = toElevenLabsSessionOptions({
      credentials: { connection: "webrtc", conversationToken: "tok", serverLocation: "us", mock: false },
      clientTools: {},
      dynamicVariables: vars,
    });
    expect(options.dynamicVariables).toEqual(vars);
  });
});

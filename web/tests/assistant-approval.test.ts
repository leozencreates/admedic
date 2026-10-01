import { describe, expect, it, vi } from "vitest";
import { ASSISTANT_TOOLS, type ToolDef } from "../app/_lib/assistant/registry";
import { createToolRuntime } from "../app/_lib/assistant/runtime";
import { RefMap } from "../app/_lib/assistant/ref-map";

/**
 * ADR-0002 `approval.test.ts`'in sesli asistan karşılığı (ADR-0028 §2, R4): sesle hiçbir zaman onay/ret, silme,
 * gizlilik, harcama yetkisi, tavan, faturalama ödemesi, OAuth/bağlantı ya da hasta mesajı yapılamaz. Hem kayıttaki
 * bildirilen uçlar hem de araçların gerçekte çağırdığı uçlar denetlenir.
 */
const FORBIDDEN_ENDPOINT =
  /approve|reject|privacy|delete|spend-authority|spend-cap|monthly-cap|\/cap\b|checkout|stripe|portal|oauth|connect|disconnect|messages|conversations|ai\/chat|escalat|capi|go-live|policy-rules|login|logout|members|invit|\/apply\b|\/publish\b|\/budget\b|\/submit\b/i;
const FORBIDDEN_TOOL_NAME = /approve|reject|delete|privacy|erase|authority|cap|checkout|billing_change|plan_change|oauth|connect|message|chat|escalat|send|apply|publish|activate|budget|go_live|login|logout/;

const tools = ASSISTANT_TOOLS as readonly ToolDef[];

const SAMPLE_PARAMS: Record<string, Record<string, unknown>> = {
  navigate_to: { pageKey: "campaigns" },
  open_campaign: { ref: "c1", tab: "performance" },
  open_lead: { ref: "l1" },
  get_campaign: { ref: "c1" },
};

function endpointPattern(endpoint: string): { method: string; path: RegExp } {
  const [method, path] = endpoint.split(" ");
  return { method, path: new RegExp(`^${path.replace(/:[a-z]+/g, "[^/?]+")}(\\?.*)?$`) };
}

describe("sesli asistan onay kapısı (ADR-0028 R4 ≈ ADR-0002)", () => {
  it("kayıtta R4 işlemine giden araç adı yok", () => {
    for (const t of tools) expect(t.name, t.name).not.toMatch(FORBIDDEN_TOOL_NAME);
  });

  it("bildirilen uçların hepsi GET ve hiçbiri yasak uç değil", () => {
    for (const t of tools)
      for (const endpoint of t.endpoints) {
        expect(endpoint, t.name).toMatch(/^GET \/api\//);
        expect(endpoint, t.name).not.toMatch(FORBIDDEN_ENDPOINT);
      }
  });

  it("araçlar çalıştırıldığında yalnızca bildirdikleri GET uçlarını çağırır", async () => {
    const calls: { url: string; method: string; data: unknown }[] = [];
    const api = vi.fn(async (url: string, method = "GET", data?: unknown) => {
      calls.push({ url, method, data });
      return {} as never;
    });
    const refs = new RefMap();
    refs.ref("campaign", "cmp_fake_1");
    refs.ref("lead", "lead_fake_1");
    const push = vi.fn();
    const runtime = createToolRuntime({
      role: "OWNER",
      canApproveSpend: true,
      router: { push },
      api,
      refs,
      reportEvent: () => undefined,
      openLeadSearch: () => undefined,
      stop: () => undefined,
    });
    expect(Object.keys(runtime.clientTools)).toHaveLength(tools.length);
    for (const t of tools) {
      const before = calls.length;
      const result = await runtime.clientTools[t.name](SAMPLE_PARAMS[t.name] ?? {});
      expect(result, t.name).not.toMatch(/"ok":false/);
      const made = calls.slice(before);
      expect(made.length, t.name).toBe(t.endpoints.length);
      for (const call of made) {
        expect(call.method, t.name).toBe("GET");
        expect(call.data, t.name).toBeUndefined();
        expect(call.url, t.name).not.toMatch(FORBIDDEN_ENDPOINT);
        expect(t.endpoints.some((e) => endpointPattern(e).path.test(call.url)), `${t.name} → ${call.url}`).toBe(true);
      }
    }
    // Gezinme araçları da yasak sayfalara gitmez (onaylar sayfası açılır ama onay vermez).
    for (const [href] of push.mock.calls) expect(String(href)).not.toMatch(/^\/api\/|approve|privacy|oauth/);
  });
});

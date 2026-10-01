import { describe, expect, it } from "vitest";
import type { Role } from "@admedic/database";
import {
  ASSISTANT_TOOLS,
  PAGE_KEYS,
  toElevenLabsToolConfigs,
  toolsFor,
  type ToolDef,
} from "../app/_lib/assistant/registry";
import { TOOL_HANDLERS } from "../app/_lib/assistant/runtime";
import { NAV_ITEMS } from "../app/_lib/nav-tree";

const ROLES: Role[] = ["OWNER", "ADMIN", "MEDIA_BUYER", "PATIENT_COORDINATOR", "ANALYST", "VIEWER"];
const names = (role: Role, spend = false) => toolsFor(role, spend).map((t) => t.name);
const tools = ASSISTANT_TOOLS as readonly ToolDef[];

describe("sesli asistan araç kaydı (ADR-0028)", () => {
  it("araç adları benzersiz snake_case ve ElevenLabs ad kuralına uyar", () => {
    const all = tools.map((t) => t.name);
    expect(new Set(all).size).toBe(all.length);
    for (const name of all) {
      expect(name).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
      expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    }
  });

  it("Faz 2: yalnızca R0 araçları var ve her aracın uygulaması var", () => {
    for (const t of tools) {
      expect(t.risk).toBe("R0");
      expect(TOOL_HANDLERS[t.name], t.name).toBeTypeOf("function");
      expect(t.description.length).toBeGreaterThan(10);
    }
    expect(Object.keys(TOOL_HANDLERS).sort()).toEqual(tools.map((t) => t.name).sort());
    // plan_campaign Faz 0 doğrulamasına kadar yok.
    expect(tools.map((t) => t.name)).not.toContain("plan_campaign");
  });

  it("hiçbir araç çalışma alanı, kuruluş ya da ham kimlik parametresi almaz", () => {
    for (const t of tools) {
      const keys = Object.keys(t.parameters.shape);
      for (const key of keys) expect(key, `${t.name}.${key}`).not.toMatch(/workspace|org|^id$|Id$|userId|email|phone|name/i);
      // Bilinmeyen alan reddedilir (strict).
      expect(t.parameters.safeParse({ workspaceId: "ws_fake" }).success, t.name).toBe(false);
    }
  });

  it("toolsFor rol süzgeci: hesap sahibi her şeyi, izleyici yalnızca izinli okuma ve gezinmeyi görür", () => {
    expect(names("OWNER")).toHaveLength(tools.length);
    expect(names("ADMIN")).toHaveLength(tools.length);

    const viewer = names("VIEWER");
    for (const hidden of ["list_alerts", "get_lead_stats", "open_lead", "open_lead_search", "open_approvals", "open_new_campaign_planner", "get_subscription"])
      expect(viewer).not.toContain(hidden);
    for (const visible of ["navigate_to", "list_campaigns", "get_insights", "open_campaign", "stop_assistant"]) expect(viewer).toContain(visible);

    const coordinator = names("PATIENT_COORDINATOR");
    expect(coordinator).toContain("get_lead_stats");
    expect(coordinator).toContain("open_lead_search");
    expect(coordinator).toContain("list_alerts");
    expect(coordinator).not.toContain("open_campaign");
    expect(coordinator).not.toContain("open_approvals");
    expect(coordinator).not.toContain("get_subscription");

    const buyer = names("MEDIA_BUYER");
    expect(buyer).toContain("open_approvals");
    expect(buyer).toContain("open_new_campaign_planner");
    expect(buyer).not.toContain("get_subscription");

    const analyst = names("ANALYST");
    expect(analyst).toContain("get_lead_stats");
    expect(analyst).not.toContain("open_approvals");
  });

  it("harcama yetkisi R0 listesini değiştirmez (R3 araçları Faz 4'te)", () => {
    for (const role of ROLES) expect(names(role, true)).toEqual(names(role, false));
  });

  it("sayfa anahtarları menü ağacının tamamıdır", () => {
    expect(PAGE_KEYS).toHaveLength(NAV_ITEMS.length);
    expect(PAGE_KEYS).toContain("overview");
    expect(PAGE_KEYS).toContain("campaign-planner");
    expect(new Set(PAGE_KEYS).size).toBe(PAGE_KEYS.length);
  });
});

describe("ElevenLabs istemci aracı yapılandırması", () => {
  const configs = toElevenLabsToolConfigs();

  it("her araç için ClientToolConfig alanlarını üretir", () => {
    expect(configs.map((c) => c.name)).toEqual(tools.map((t) => t.name));
    for (const c of configs) {
      expect(c.type).toBe("client");
      expect(c.description).toBeTruthy();
      expect(typeof c.expects_response).toBe("boolean");
      expect(c.response_timeout_secs).toBeGreaterThanOrEqual(1);
      expect(c.response_timeout_secs).toBeLessThanOrEqual(120);
      for (const [key, prop] of Object.entries(c.parameters?.properties ?? {})) {
        expect(prop.description, `${c.name}.${key}`).toBeTruthy();
        expect(["string", "number", "integer", "boolean"]).toContain(prop.type);
      }
    }
  });

  it("parametreli araçta şema, zorunlu alanlar ve enum doğru; parametresiz araçta şema yok", () => {
    const nav = configs.find((c) => c.name === "navigate_to")!;
    expect(nav.parameters).toMatchObject({ type: "object", required: ["pageKey"] });
    expect(nav.parameters!.properties.pageKey.enum).toEqual([...PAGE_KEYS]);

    const open = configs.find((c) => c.name === "open_campaign")!;
    expect(open.parameters!.required).toEqual(["ref"]);
    expect(open.parameters!.properties.tab.enum).toEqual(["overview", "content", "publish", "performance", "decisions"]);

    expect(configs.find((c) => c.name === "get_today_summary")!.parameters).toBeUndefined();
    expect(configs.find((c) => c.name === "stop_assistant")!.expects_response).toBe(false);
    expect(configs.find((c) => c.name === "list_campaigns")!.expects_response).toBe(true);
  });
});

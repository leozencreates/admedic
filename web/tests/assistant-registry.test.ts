import { describe, expect, it } from "vitest";
import type { Role } from "@admedic/database";
import {
  ASSISTANT_TOOLS,
  PAGE_KEYS,
  toElevenLabsToolConfigs,
  toolsFor,
  type ToolDef,
} from "../app/_lib/assistant/registry";
import { ACTION_HANDLERS, PENDING_TOOLS, TOOL_HANDLERS } from "../app/_lib/assistant/runtime";
import { PLAN_OBJECTIVES } from "../app/_lib/campaign-plan";
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

  it("Faz 4: R0–R3 araçları var; her aracın tek bir uygulaması var; R2/R3 yalnızca ekranda onaylanır", () => {
    const pendingTools: readonly string[] = PENDING_TOOLS;
    for (const t of tools) {
      expect(["R0", "R1", "R2", "R3"], t.name).toContain(t.risk);
      expect(t.description.length).toBeGreaterThan(10);
      // Ekranda onay yalnızca R2/R3'te ve orada zorunlu.
      expect(Boolean(t.screenOnly), t.name).toBe(t.risk === "R2" || t.risk === "R3");
      if (t.risk !== "R0") {
        // R1–R3 yalnızca hazırla → onay yolundan çalışır; doğrudan işleyicisi yoktur.
        expect(ACTION_HANDLERS[t.name]?.prepare, t.name).toBeTypeOf("function");
        expect(ACTION_HANDLERS[t.name]?.execute, t.name).toBeTypeOf("function");
        expect(TOOL_HANDLERS[t.name], t.name).toBeUndefined();
      } else if (pendingTools.includes(t.name)) {
        expect(TOOL_HANDLERS[t.name], t.name).toBeUndefined();
      } else {
        expect(TOOL_HANDLERS[t.name], t.name).toBeTypeOf("function");
        expect(ACTION_HANDLERS[t.name], t.name).toBeUndefined();
      }
    }
    expect([...Object.keys(TOOL_HANDLERS), ...Object.keys(ACTION_HANDLERS), ...pendingTools].sort()).toEqual(
      tools.map((t) => t.name).sort(),
    );
    // R1 araçları ve onay araçları
    expect(tools.filter((t) => t.risk === "R1").map((t) => t.name).sort()).toEqual(
      [
        "create_campaign_draft",
        "generate_ad_copy",
        "refetch_leads",
        "save_studio_draft",
        "submit_campaign_for_review",
        "submit_recommendation_for_review",
        "submit_studio_draft",
        "update_alert",
        // Faz 5: manuel A/B ölçümü (iç veri).
        "update_experiment_metrics",
      ].sort(),
    );
    expect(tools.filter((t) => t.risk === "R2").map((t) => t.name).sort()).toEqual(
      ["archive_campaign", "decrease_budget", "pause_campaign", "publish_campaign_paused", "sync_meta_review", "update_lead_status"].sort(),
    );
    expect(tools.filter((t) => t.risk === "R3").map((t) => t.name).sort()).toEqual(
      ["activate_campaign", "apply_recommendation", "increase_budget"].sort(),
    );
    for (const name of ["confirm_pending_action", "cancel_pending_action", "get_current_context"])
      expect(tools.find((t) => t.name === name)?.risk, name).toBe("R0");
    // plan_campaign Faz 0 doğrulamasına kadar yok.
    expect(tools.map((t) => t.name)).not.toContain("plan_campaign");
  });

  it("hiçbir araç çalışma alanı, kuruluş ya da ham kimlik parametresi almaz", () => {
    for (const t of tools) {
      const keys = Object.keys(t.parameters.shape);
      for (const key of keys) {
        // Tek istisna: onay araçlarının, R1 aracının döndürdüğü rastgele `pendingId` değeri (kayıt kimliği değil).
        if (key === "pendingId" && (PENDING_TOOLS as readonly string[]).includes(t.name)) continue;
        expect(key, `${t.name}.${key}`).not.toMatch(/workspace|org|^id$|Id$|userId|email|phone|name|message|note|text/i);
      }
      // Bilinmeyen alan reddedilir (strict).
      expect(t.parameters.safeParse({ workspaceId: "ws_fake" }).success, t.name).toBe(false);
    }
  });

  it("toolsFor rol süzgeci: hesap sahibi her şeyi, izleyici yalnızca izinli okuma ve gezinmeyi görür", () => {
    expect(names("OWNER", true)).toHaveLength(tools.length);
    expect(names("ADMIN", true)).toHaveLength(tools.length);

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
    // A/B testleri menüdeki gibi (READ_ADS): koordinatör görmez, izleyici ve analist okur.
    expect(analyst).toContain("list_experiments");
    expect(viewer).toContain("list_experiments");
    expect(coordinator).not.toContain("list_experiments");
  });

  it("R1 rol süzgeci uçların sunucu kuralını izler", () => {
    const r1 = (role: Role) => toolsFor(role, false).filter((t) => t.risk === "R1").map((t) => t.name).sort();
    // İzleyici ve analist hiçbir iç yazma yapamaz.
    expect(r1("VIEWER")).toEqual([]);
    expect(r1("ANALYST")).toEqual([]);
    // Hasta koordinatörü: CARE uçları (yeniden çekme) ve devir uyarısı. Lead durumu Faz 4'te R2.
    expect(r1("PATIENT_COORDINATOR")).toEqual(["refetch_leads", "update_alert"]);
    // Reklam uzmanı: EDIT + CARE; öneri kuyruğu yalnızca OWNER/ADMIN.
    expect(r1("MEDIA_BUYER")).not.toContain("submit_recommendation_for_review");
    expect(r1("MEDIA_BUYER")).toContain("create_campaign_draft");
    // A/B ölçümü: sunucu `updateExperiment` EDIT_ROLES; koordinatör ve analist bağlamaz.
    expect(r1("MEDIA_BUYER")).toContain("update_experiment_metrics");
    expect(r1("PATIENT_COORDINATOR")).not.toContain("update_experiment_metrics");
    expect(r1("ADMIN")).toContain("submit_recommendation_for_review");
    // Onay araçları R0 düzeyinde herkese bağlıdır (onaylanacak bir R1 yoksa işe yaramaz).
    expect(names("VIEWER")).toContain("confirm_pending_action");
    expect(names("VIEWER")).toContain("get_current_context");
  });

  it("kampanya hedefleri planlayıcıyla aynı", () => {
    const create = tools.find((t) => t.name === "create_campaign_draft")!;
    expect(create.parameters.safeParse({ title: "x", dailyBudget: 10, objective: PLAN_OBJECTIVES[1] }).success).toBe(true);
    expect(create.parameters.safeParse({ title: "x", dailyBudget: 10, objective: "OUTCOME_SALES" }).success).toBe(false);
    expect(create.parameters.safeParse({ title: "x", dailyBudget: -1 }).success).toBe(false);
  });

  it("R2/R3 rol süzgeci: kampanya araçları düzenleme rollerine, R3 yalnızca harcama yetkisiyle", () => {
    const at = (role: Role, risk: string, spend = false) =>
      toolsFor(role, spend).filter((t) => t.risk === risk).map((t) => t.name).sort();
    const campaignR2 = ["archive_campaign", "decrease_budget", "pause_campaign", "publish_campaign_paused", "sync_meta_review"];
    const r3 = ["activate_campaign", "apply_recommendation", "increase_budget"];
    for (const role of ["OWNER", "ADMIN", "MEDIA_BUYER"] as Role[]) {
      expect(at(role, "R2"), role).toEqual([...campaignR2, "update_lead_status"].sort());
      // R3 harcama yetkisi olmadan hiç bağlanmaz (istemci ön süzgeci; sunucu yine denetler).
      expect(at(role, "R3"), role).toEqual([]);
      expect(at(role, "R3", true), role).toEqual(r3);
    }
    // Hasta koordinatörü yalnızca lead durumu (R2); analist ve izleyici hiçbir R2/R3 aracı bağlamaz.
    expect(at("PATIENT_COORDINATOR", "R2", true)).toEqual(["update_lead_status"]);
    for (const role of ["PATIENT_COORDINATOR", "ANALYST", "VIEWER"] as Role[]) expect(at(role, "R3", true), role).toEqual([]);
    for (const role of ["ANALYST", "VIEWER"] as Role[]) expect(at(role, "R2", true), role).toEqual([]);
    // Harcama yetkisi yalnızca R3'ü değiştirir.
    for (const role of ROLES)
      expect(names(role, true).filter((n) => !r3.includes(n))).toEqual(names(role, false));
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

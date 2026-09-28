import { describe, expect, it } from "vitest";
import { NAV_ITEMS, activeNavHref, navContext, navTreeFor, newActionsFor, tabItemsFor } from "../app/_lib/nav-tree";

const hrefs = (role: string | null) => navTreeFor(role, "tr").flatMap((g) => g.items.map((i) => i.href));

describe("menü ağacı (ADR-0017 · K2-A)", () => {
  it("her sayfa tek kez yer alır; gruplar sırayla günlük iş, reklamlar, testler, kampanyalar, performans, ayarlar", () => {
    const all = NAV_ITEMS.map((i) => i.href);
    expect(new Set(all).size).toBe(all.length);
    expect(navTreeFor("OWNER", "tr").map((g) => g.id)).toEqual(["daily", "ads", "tests", "campaigns", "performance", "settings"]);
    expect(navTreeFor("OWNER", "tr")[0].label).toBeNull();
    expect(navTreeFor("OWNER", "tr")[5].label).toBe("Ayarlar");
    expect(navTreeFor("OWNER", "en")[1].label).toBe("Ads");
  });

  it("hesap sahibi her şeyi görür; hasta koordinatörü yalnızca Lead'ler ve Uyarılar", () => {
    expect(hrefs("OWNER")).toHaveLength(NAV_ITEMS.length);
    expect(hrefs("PATIENT_COORDINATOR")).toEqual(["/leads", "/alerts"]);
    expect(navTreeFor("PATIENT_COORDINATOR", "tr").map((g) => g.id)).toEqual(["daily", "performance"]);
  });

  it("izleyici onay, lead, uyarı ve ayar görmez; analist lead'leri görür ama ayarları görmez", () => {
    const viewer = hrefs("VIEWER");
    for (const hidden of ["/approvals", "/leads", "/alerts", "/clinic", "/billing", "/studio"]) expect(viewer).not.toContain(hidden);
    expect(viewer).toContain("/insights");
    const analyst = hrefs("ANALYST");
    expect(analyst).toContain("/leads");
    expect(analyst).not.toContain("/clinic");
    expect(analyst).not.toContain("/approvals");
  });

  it("reklam uzmanı klinik sayfasını görür, faturaları ve Meta bağlantılarını görmez", () => {
    const mb = hrefs("MEDIA_BUYER");
    expect(mb).toContain("/clinic");
    expect(mb).not.toContain("/billing");
    expect(mb).not.toContain("/meta-connections");
  });

  it("rol bilinmiyorsa tüm menü döner (sayfalar oturumu ayrıca denetler)", () => {
    expect(hrefs(null)).toHaveLength(NAV_ITEMS.length);
    expect(hrefs("SOMETHING")).toHaveLength(NAV_ITEMS.length);
  });

  it("etkin öğe en uzun önekle bulunur; kayıt sayfası üst öğeye bağlanır", () => {
    expect(activeNavHref("/")).toBe("/");
    expect(activeNavHref("/leads/abc")).toBe("/leads");
    expect(activeNavHref("/campaign-planner")).toBe("/campaign-planner");
    expect(activeNavHref("/campaigns")).toBe("/campaigns");
    expect(activeNavHref("/tests/x")).toBe("/tests");
    expect(activeNavHref("/login")).toBeNull();
    expect(navContext("/campaign-planner", "tr")).toEqual({ group: "Kampanyalar", page: "Yeni kampanya", href: "/campaign-planner" });
    expect(navContext("/approvals", "tr").group).toBeNull();
  });

  it("mobil alt sekmeler rol başına en çok 4 hedeftir ve rolün göremediği hedef atlanır", () => {
    expect(tabItemsFor("OWNER", "tr").map((t) => t.href)).toEqual(["/", "/approvals", "/leads", "/campaigns"]);
    expect(tabItemsFor("PATIENT_COORDINATOR", "tr").map((t) => t.href)).toEqual(["/leads", "/alerts"]);
    expect(tabItemsFor("VIEWER", "tr").map((t) => t.href)).toEqual(["/", "/insights", "/campaigns"]);
    for (const role of ["OWNER", "ADMIN", "MEDIA_BUYER", "PATIENT_COORDINATOR", "ANALYST", "VIEWER"]) {
      expect(tabItemsFor(role, "tr").length).toBeLessThanOrEqual(4);
      const visible = hrefs(role);
      for (const tab of tabItemsFor(role, "tr")) expect(visible).toContain(tab.href);
    }
  });

  it("'Yeni' kısayolları yalnızca düzenleme rollerinde", () => {
    expect(newActionsFor("OWNER").map((a) => a.href)).toEqual(["/studio", "/campaign-planner", "/experiments"]);
    expect(newActionsFor("PATIENT_COORDINATOR")).toEqual([]);
    expect(newActionsFor("VIEWER")).toEqual([]);
    expect(newActionsFor(null)).toEqual([]);
  });

  it("tek öğesi grupla aynı adı taşıyan grup başlık tekrar etmez (izleyici: Kampanyalar)", () => {
    const campaigns = navTreeFor("VIEWER", "tr").find((g) => g.id === "campaigns")!;
    expect(campaigns.items.map((i) => i.label)).toEqual(["Kampanyalar"]);
    expect(campaigns.label).toBeNull();
    expect(navTreeFor("OWNER", "tr").find((g) => g.id === "campaigns")!.label).toBe("Kampanyalar");
  });
  it("alt sekme çubuğunda uzun ad kısaltılır", () => {
    expect(tabItemsFor("MEDIA_BUYER", "tr").find((t) => t.href === "/studio")?.label).toBe("Oluştur");
  });
});

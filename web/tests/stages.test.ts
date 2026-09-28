import { describe, expect, it } from "vitest";
import { campaignStage, leadStage, stageSentence } from "../app/_lib/stages";

describe("aşama şeridi (K8-C)", () => {
  it("kampanya: 5 aşama; insan bekleyen aşamalar amber, düzeltme kırmızı, yayında tamam", () => {
    expect(campaignStage("DRAFT")).toMatchObject({ index: 0, total: 5, state: "progress", label: "Taslak" });
    expect(campaignStage("IN_REVIEW")).toMatchObject({ index: 1, state: "human", label: "Onay bekliyor" });
    expect(campaignStage("REJECTED")).toMatchObject({ index: 1, state: "problem", label: "Düzeltme istendi" });
    expect(campaignStage("APPROVED")).toMatchObject({ index: 2, state: "progress" });
    expect(campaignStage("APPROVED", { publishIncomplete: true })).toMatchObject({ index: 2, state: "human", label: "Yükleme yarım kaldı" });
    expect(campaignStage("PUBLISHED_PAUSED")).toMatchObject({ index: 3, state: "human", label: "Etkinleştirme bekliyor" });
    expect(campaignStage("ACTIVE")).toMatchObject({ index: 4, state: "done", label: "Yayında" });
    expect(campaignStage("ACTIVE", { metaPaused: true })).toMatchObject({ state: "idle", label: "Duraklatıldı" });
    expect(campaignStage("ARCHIVED")).toMatchObject({ state: "idle" });
  });

  it("lead: 6 aşama; yanıt bekleyen amber, tedavi tamam, kayıp gri", () => {
    expect(leadStage("NEW")).toMatchObject({ index: 0, total: 6, state: "human" });
    expect(leadStage("QUALIFIED")).toMatchObject({ index: 2, state: "progress" });
    expect(leadStage("TREATED")).toMatchObject({ index: 5, state: "done" });
    expect(leadStage("LOST")).toMatchObject({ state: "idle", label: "Kaybedildi" });
  });

  it("ekran okuyucu cümlesi aşama numarası, adı ve etiketi içerir", () => {
    expect(stageSentence(campaignStage("PUBLISHED_PAUSED"))).toBe("Aşama 4/5 (Etkinleştirme): Etkinleştirme bekliyor");
  });
});

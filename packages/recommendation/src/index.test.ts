import { describe, it, expect, vi } from "vitest";
import { generateRecommendations } from "./index";
import { prisma } from "@admedic/database";

vi.mock("@admedic/database", () => ({
  prisma: {
    studioExperiment: {
      findUnique: vi.fn(),
    },
  },
}));

describe("recommendation engine", () => {
  it("produces budget reallocation for winning variant", async () => {
    (prisma.studioExperiment.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "exp-1", status: "COMPLETED",
      snapshot: JSON.stringify({ variants: [{ headline: "V1" }, { headline: "V2" }], duration: 7 }),
      metrics: JSON.stringify([{ spend: 350, clicks: 1000, leads: 50 }, { spend: 350, clicks: 1000, leads: 110 }]),
    });
    const recs = await generateRecommendations({ experimentId: "exp-1", workspaceId: "ws-1" });
    expect(recs.length).toBe(1);
    expect(recs[0].type).toBe("BUDGET_REALLOCATION");
    expect(recs[0].status).toBe("DRAFT");
    expect(recs[0].priority).toBe("HIGH");
  });

  it("produces experiment-end suggestion when no leads exist", async () => {
    (prisma.studioExperiment.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "exp-2", status: "COMPLETED",
      snapshot: JSON.stringify({ variants: [{ headline: "V1" }, { headline: "V2" }], duration: 7 }),
      metrics: JSON.stringify([{ spend: 350, clicks: 1000, leads: 0 }, { spend: 350, clicks: 1000, leads: 0 }]),
    });
    const recs = await generateRecommendations({ experimentId: "exp-2", workspaceId: "ws-1" });
    expect(recs.length).toBe(1);
    expect(recs[0].type).toBe("EXPERIMENT_END");
    expect(recs[0].priority).toBe("MEDIUM");
  });

  it("returns empty for non-completed experiments", async () => {
    (prisma.studioExperiment.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "exp-3", status: "DRAFT", snapshot: "{}", metrics: "[]",
    });
    const recs = await generateRecommendations({ experimentId: "exp-3", workspaceId: "ws-1" });
    expect(recs.length).toBe(0);
  });
});

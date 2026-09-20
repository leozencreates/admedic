import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { buildApp } from "../src/app";
import { prisma } from "../src/lib";

let app: Awaited<ReturnType<typeof buildApp>>;

describe("api caps (read-only REST, ADR-0001/0003 sözleşmesi)", () => {
  beforeAll(async () => {
    app = await buildApp({ logger: false });
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it("health → ok", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, service: "admedic-api" });
  });

  it("GET /v1/overview → tek kiracılı çalışma alanı + 7g metrikler", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/overview?days=7" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.workspace.name).toBeTruthy();
    expect(body.days).toBe(7);
    expect(body.counts).toMatchObject({ campaigns: 5, adsets: 10, ads: 50 });
    expect(body.lastNDays.spendCents).toBeGreaterThan(0);
    expect(body.lastNDays.roas === null || typeof body.lastNDays.roas === "number").toBe(true);
    expect(body.approvals.pending).toBeGreaterThan(0);
    expect(body.alerts.open).toBeGreaterThan(0);
    expect(body.policy.mode).toBe("APPROVAL");
  });

  it("GET /v1/campaigns → 5 kampanya, her biri adAccount + adSetCount + ROAS", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/campaigns?days=7" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.campaigns).toHaveLength(5);
    for (const c of body.campaigns) {
      expect(c.name).toBeTruthy();
      expect(c.adAccount.currency).toBeTruthy();
      expect(c.adSetCount).toBeGreaterThan(0);
      expect(c.lastNDays.roas === null || typeof c.lastNDays.roas === "number").toBe(true);
    }
  });

  it("GET /v1/decisions → onay özeti + karar listesi", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/decisions" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.summary).toHaveProperty("PENDING");
    expect(body.decisions.length).toBeGreaterThan(0);
  });

  it("GET /v1/alerts → açık uyarı özeti (open/critical/warning)", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/alerts" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.summary.open).toBeGreaterThanOrEqual(body.summary.critical + body.summary.warning);
    expect(body.alerts.length).toBeGreaterThan(0);
  });
});

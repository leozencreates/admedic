import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma, PrismaClient } from "@prisma/client";
import { anonymizeExpiredLeads, anonymizeLead } from "./privacy";

const tx = {
  lead: { findFirst: vi.fn(), updateMany: vi.fn() },
  message: { updateMany: vi.fn() }, conversation: { updateMany: vi.fn() },
  consentRecord: { updateMany: vi.fn() }, voiceCall: { updateMany: vi.fn() }, auditLog: { create: vi.fn() }, $queryRaw: vi.fn(),
};
const subject = { id: "lead", orgId: "org", workspaceId: "workspace" };
const asTx = tx as unknown as Prisma.TransactionClient;

describe("privacy erasure", () => {
  beforeEach(() => { vi.clearAllMocks(); tx.lead.findFirst.mockResolvedValue({ id: "lead" }); });
  it("removes contact hashes, health interest and consent as well as message content", async () => {
    expect(await anonymizeLead(asTx, subject)).toBe(true);
    expect(tx.lead.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "lead", organizationId: "org", workspaceId: "workspace" },
      data: expect.objectContaining({ lookupHash: null, interestedService: null, consentGiven: false, phone: null, email: null }),
    }));
    expect(tx.message.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { conversation: { leadId: "lead", workspaceId: "workspace" } },
      data: { content: "[anonymized]", sender: null, metadata: {} },
    }));
    // Sesli arama özeti ve sağlayıcı kimlikleri de silinir (ADR-0026).
    expect(tx.voiceCall.updateMany).toHaveBeenCalledWith({
      where: { leadId: "lead", workspaceId: "workspace" },
      data: { summary: null, conversationId: null, providerCallId: null },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ after: { anonymized: true } }) }));
  });
  it("does not write when the subject is outside the tenant", async () => {
    tx.lead.findFirst.mockResolvedValue(null);
    expect(await anonymizeLead(asTx, subject)).toBe(false);
    expect(tx.lead.updateMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
  it("scopes retention to a workspace, all statuses, and supports a read-only dry run", async () => {
    const db = { lead: { findMany: vi.fn().mockResolvedValue([{ id: "lead" }]) }, $transaction: vi.fn() };
    expect(await anonymizeExpiredLeads(db as unknown as PrismaClient, { orgId: "org", workspaceId: "workspace", retentionDays: 30 }, { now: new Date("2026-09-26T00:00:00Z"), dryRun: true })).toBe(1);
    const where = db.lead.findMany.mock.calls[0]![0].where;
    expect(where).toMatchObject({ organizationId: "org", workspaceId: "workspace", updatedAt: { lt: new Date("2026-08-27T00:00:00Z") } });
    expect(where.status).toBeUndefined();
    // Zaten anonimleştirilmiş lead ad yer tutucusuyla dışarıda kalır; JSON yol süzgeci kullanılmaz (privacy.db.test.ts).
    expect(where.firstName).toEqual({ not: "[anonymized]" });
    expect(where.NOT).toBeUndefined();
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it("rechecks retention after locking and skips a newly active lead", async () => {
    tx.lead.findFirst.mockResolvedValue(null);
    const db = { lead: { findMany: vi.fn().mockResolvedValue([{ id: "lead" }]) }, $transaction: (run: (t: typeof tx) => Promise<number>) => run(tx) };
    expect(await anonymizeExpiredLeads(db as unknown as PrismaClient, { orgId: "org", workspaceId: "workspace", retentionDays: 30 })).toBe(0);
    expect(tx.lead.updateMany).not.toHaveBeenCalled();
  });
});

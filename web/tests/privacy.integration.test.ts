import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@admedic/database";

const { actor } = vi.hoisted(() => ({ actor: { orgId: "", workspaceId: "", userId: "", role: "OWNER" } }));
vi.mock("../app/_lib/auth", () => ({
  requireActor: async () => actor,
  requireRole: () => {},
}));
import { GET, DELETE } from "../app/api/privacy/[userId]/route";

describe.skipIf(process.env.STUDIO_DB_TEST !== "1")("lead privacy isolation", () => {
  const orgs: string[] = [];
  const ids: string[] = [];
  let userId: string;
  beforeAll(async () => {
    const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.invalid` } });
    userId = user.id;
    actor.userId = userId;
    for (let i = 0; i < 2; i++) {
      const org = await prisma.organization.create({ data: {
        name: "Privacy fixture", slug: randomUUID(),
        workspaces: { create: { name: "Fixture", slug: "main" } },
      }, include: { workspaces: true } });
      orgs.push(org.id);
      const workspaceId = org.workspaces[0].id;
      if (i === 0) Object.assign(actor, { workspaceId, orgId: org.id });
      for (let j = 0; j < 2; j++) {
        const lead = await prisma.lead.create({ data: {
          workspaceId, organizationId: org.id, firstName: "Fixture", lastName: "Subject",
          metadata: { privateNote: "fixture" },
          conversations: { create: { workspaceId, channel: "WHATSAPP", messages: {
            create: { direction: "INCOMING", channel: "WHATSAPP", content: "Fixture text", metadata: { privateNote: "fixture" } },
          } } },
        } });
        ids.push(lead.id);
      }
    }
  });
  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: orgs } } });
    if (userId) await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });
  const request = (method: string) => new Request("http://localhost:3000/api/privacy/test", {
    method, headers: { origin: process.env.AUTH_URL ?? "http://localhost:3000" },
  });
  it("rejects another workspace's lead and login-user IDs", async () => {
    for (const id of [ids[2], userId]) {
      const context = { params: Promise.resolve({ userId: id }) };
      expect((await GET(request("GET"), context)).status).toBe(404);
      expect((await DELETE(request("DELETE"), context)).status).toBe(404);
    }
  });
  it("exports one subject and anonymizes only that subject including message metadata", async () => {
    const context = { params: Promise.resolve({ userId: ids[0] }) };
    const response = await GET(request("GET"), context);
    expect((await response.json()).lead.id).toBe(ids[0]);
    expect((await DELETE(request("DELETE"), context)).status).toBe(200);
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: ids[0] }, include: { conversations: { include: { messages: true } } } });
    expect(lead.firstName).toBe("[anonymized]");
    expect(lead.metadata).toEqual({});
    expect(lead.conversations[0].status).toBe("CLOSED");
    expect(lead.conversations[0].messages[0].metadata).toEqual({});
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: ids[1] } })).firstName).toBe("Fixture");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).email).toContain("example.invalid");
  });
});

import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { prisma } from "@admedic/database";
import { SESSION_COOKIE, type Actor } from "../app/_lib/auth";
import { tokenHash, hashPassword } from "../app/_lib/password";
import { encrypt } from "../app/_lib/encrypt";
import { POST as escalate } from "../app/api/conversations/[id]/escalate/route";
import { POST as sendMsg } from "../app/api/leads/[id]/messages/route";

const { cookieJar } = vi.hoisted(() => ({
  cookieJar: new Map<string, string>(),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (key: string) =>
      cookieJar.has(key) ? { value: cookieJar.get(key) } : undefined,
    set: (key: string, value: string) => cookieJar.set(key, value),
    delete: (key: string) => cookieJar.delete(key),
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: () => { throw new Error("redirect"); },
}));

const suffix = randomBytes(8).toString("hex");
const password = randomBytes(24).toString("hex");
const email = `chat-${suffix}@example.invalid`;
const token = randomBytes(32).toString("hex");
let owner: Actor;
let leadId: string;
let conversationId: string;
let userId: string;

function request(method: string, body?: unknown) {
  return new Request("http://localhost:3000/api/test", {
    method,
    headers: {
      origin: process.env.AUTH_URL ?? "http://localhost:3000",
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe.skipIf(process.env.STUDIO_DB_TEST !== "1")("chat and escalation", () => {
  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { email, passwordHash: await hashPassword(password) },
    });
    userId = user.id;
    const org = await prisma.organization.create({
      data: { name: "Chat fixture", slug: `chatfix-${suffix}` },
    });
    const ws = await prisma.workspace.create({
      data: { orgId: org.id, name: "Chat fixture", slug: "main" },
    });
    await prisma.membership.create({
      data: { orgId: org.id, userId: user.id, role: "OWNER" },
    });
    owner = { userId: user.id, orgId: org.id, workspaceId: ws.id, role: "OWNER", workspaceName: "Chat fixture" };
    const lead = await prisma.lead.create({
      data: { workspaceId: ws.id, organizationId: org.id, firstName: "Chat", lastName: "Test", phone: encrypt("+905551234567"), email: encrypt("chat@example.invalid"), channel: "WHATSAPP", status: "NEW" },
    });
    leadId = lead.id;
    const conv = await prisma.conversation.create({
      data: { leadId, workspaceId: ws.id, channel: "WHATSAPP", status: "ACTIVE" },
    });
    conversationId = conv.id;
    await prisma.message.create({
      data: { conversationId, direction: "INCOMING", channel: "WHATSAPP", content: "merhaba", sender: "external" },
    });
    await prisma.webSession.create({
      data: { tokenHash: tokenHash(token), userId, workspaceId: ws.id, expiresAt: new Date(Date.now() + 86400000) },
    });
    cookieJar.set(SESSION_COOKIE, token);
  });
  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { orgId: owner.orgId } });
    await prisma.conversation.deleteMany({ where: { leadId } });
    await prisma.lead.delete({ where: { id: leadId } });
    await prisma.workspace.delete({ where: { id: owner.workspaceId } });
    await prisma.organization.delete({ where: { id: owner.orgId } });
    await prisma.user.delete({ where: { id: owner.userId } });
    await prisma.$disconnect();
  });
  it("escalates an active conversation", async () => {
    const res = await escalate(request("POST", { note: "Test" }), { params: Promise.resolve({ id: conversationId }) });
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.conversation.status).toBe("ESCALATED");
    // Sistem notu kullanıcı kimliği yerine e-postanın yerel kısmını taşır.
    const note = await prisma.message.findFirstOrThrow({ where: { conversationId, sender: "system" } });
    expect(note.content).toContain(`chat-${suffix}`);
    expect(note.content).not.toContain(userId);
    expect(note.content).toContain("Test");
  });
  it("cannot escalate an already-escalated conversation", async () => {
    const res = await escalate(request("POST", { note: "Again" }), { params: Promise.resolve({ id: conversationId }) });
    expect(res.status).toBe(409);
  });
  it("lets the owner keep writing after takeover (assistant stays silent)", async () => {
    const res = await sendMsg(request("POST", { content: "Devraldım, yardımcı olayım." }), { params: Promise.resolve({ id: leadId }) });
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.conversation).toMatchObject({ id: conversationId, status: "ESCALATED", takenOver: false });
    expect(data.message.sender).toBe(userId);
    const conv = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(conv.status).toBe("ESCALATED");
    expect(conv.firstResponseAt).not.toBeNull();
  });
});

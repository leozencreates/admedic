import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { prisma } from "@admedic/database";
import { currentActor, SESSION_COOKIE, type Actor } from "../app/_lib/auth";
import { tokenHash, hashPassword } from "../app/_lib/password";
import { POST as login } from "../app/api/session/route";
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
let wsId: string;

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

describe("chat and escalation", () => {
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
    wsId = ws.id;
    await prisma.membership.create({
      data: { orgId: org.id, userId: user.id, role: "OWNER" },
    });
    owner = { userId: user.id, orgId: org.id, workspaceId: ws.id, role: "OWNER", workspaceName: "Chat fixture" };
    const lead = await prisma.lead.create({
      data: { workspaceId: ws.id, organizationId: org.id, firstName: "Chat", lastName: "Test", phone: "5551234567", email: "chat@example.invalid", channel: "WHATSAPP", status: "NEW" },
    });
    leadId = lead.id;
    const conv = await prisma.conversation.create({
      data: { leadId, workspaceId: ws.id, channel: "WHATSAPP", status: "ACTIVE" },
    });
    conversationId = conv.id;
    await prisma.webSession.create({
      data: { tokenHash: tokenHash(token), userId, workspaceId: ws.id, expiresAt: new Date(Date.now() + 86400000) },
    });
    const loginReq = request("POST", { email, password, workspace: wsId }); const loginRes = await login(loginReq, { params: Promise.resolve({}) });
    const loginData = await loginRes.json() as any;
    console.log("LOGIN_RES:", JSON.stringify(loginData));
    
    if (loginData?.token) {
      cookieJar.set(SESSION_COOKIE, loginData.token);
    } else {
      console.log("LOGIN_HEADERS:", Object.fromEntries(loginRes.headers.entries()));
    }
  });
  afterAll(async () => {
    await prisma.conversation.deleteMany({ where: { leadId } });
    await prisma.lead.delete({ where: { id: leadId } });
    await prisma.workspace.delete({ where: { id: owner.workspaceId } });
    await prisma.organization.delete({ where: { id: owner.orgId } });
    await prisma.user.delete({ where: { id: owner.userId } });
    await prisma.$disconnect();
  });
  it("escalates an active conversation", async () => {
    const res = await escalate(request("POST", { note: "Test" }));
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.conversation.status).toBe("ESCALATED");
  });
  it("cannot escalate an already-escalated conversation", async () => {
    const res = await escalate(request("POST", { note: "Again" }));
    expect(res.status).toBe(409);
  });
});

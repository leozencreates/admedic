import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { randomBytes, createHmac } from "node:crypto";
import { prisma } from "@admedic/database";
import { tokenHash } from "../app/_lib/password";
import { SESSION_COOKIE } from "../app/_lib/auth";
import { verifyWebhookSignature } from "../app/_lib/verify";
import {
  createOAuthState,
  parseOAuthState,
} from "../app/_lib/oauth-state";
import { encrypt, decrypt } from "../app/_lib/encrypt";
import { loadEnv } from "@admedic/config";

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
  redirect: () => {
    throw new Error("redirect");
  },
}));

import { POST as webhook } from "../app/api/leads/[id]/webhook/route";
import { POST as sendMessage } from "../app/api/leads/[id]/messages/route";

function sign(payload: string, secret: string) {
  return "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
}
function webhookRequest(payload: unknown, signature: string | null) {
  return new Request("http://localhost:3000/api/leads/x/webhook", {
    method: "POST",
    body: JSON.stringify(payload),
    headers: signature
      ? { "x-hub-signature-256": signature, "content-type": "application/json" }
      : { "content-type": "application/json" },
  });
}

describe("webhook signature and oauth state helpers", () => {
  it("verifies valid webhook signature and rejects missing/tampered/secretless", () => {
    const secret = "dev-secret";
    const payload = JSON.stringify({ a: 1 });
    const good = sign(payload, secret);
    expect(verifyWebhookSignature(payload, good, secret)).toBe(true);
    expect(verifyWebhookSignature(payload, good, "")).toBe(false);
    expect(verifyWebhookSignature(payload, good, undefined)).toBe(false);
    expect(verifyWebhookSignature(payload, null, secret)).toBe(false);
    expect(
      verifyWebhookSignature(
        payload,
        good.replace(/^sha256=([0-9a-f]{4})/, "sha256=0000"),
        secret,
      ),
    ).toBe(false);
    expect(
      verifyWebhookSignature(payload + "x", good, secret),
    ).toBe(false);
    expect(verifyWebhookSignature(payload, "sha1=deadbeef", secret)).toBe(false);
  });
  it("signs, round-trips and rejects tampered or expired oauth state", () => {
    const secret = "dev-auth-secret";
    const { state, payload } = createOAuthState(secret, "u1", "o1");
    expect(parseOAuthState(state, secret)).toMatchObject({ userId: "u1", orgId: "o1" });
    expect(parseOAuthState(state, "wrong-secret")).toBeNull();
    const [body, sig] = state.split(".");
    const tampered = `${body}.${sig.replace(/^[0-9a-f]{4}/, "ffff")}`;
    expect(parseOAuthState(tampered, secret)).toBeNull();
    expect(parseOAuthState(state, secret, payload.exp + 1)).toBeNull();
    expect(parseOAuthState("garbage.state", secret)).toBeNull();
  });
});

describe.skipIf(process.env.STUDIO_DB_TEST !== "1")(
  "webhook + whatsapp connectivity integration",
  () => {
    const suffix = randomBytes(8).toString("hex");
    const token = randomBytes(32).toString("hex");
    const webhookSecret = randomBytes(16).toString("hex");
    let userId: string;
    const orgIds: string[] = [];
    const workspaceIds: string[] = [];

    beforeAll(async () => {
      vi.stubEnv("ENCRYPTION_KEY", "82da20c19f1765f384e674dc19d7c4ecdc7dd6475527fa1cf5465f43092e21cf");
      vi.stubEnv("META_WEBHOOK_SECRET", webhookSecret);
      const user = await prisma.user.create({
        data: { email: `conn-${suffix}@example.invalid` },
      });
      userId = user.id;
      for (let i = 0; i < 2; i++) {
        const org = await prisma.organization.create({
          data: {
            name: "Conn fixture",
            slug: `connfix-${suffix}-${i}`,
            members: { create: { userId, role: "OWNER" } },
            workspaces: { create: { name: "Fixture", slug: "main" } },
          },
          include: { workspaces: true },
        });
        orgIds.push(org.id);
        workspaceIds.push(org.workspaces[0].id);
        await prisma.metaConnection.create({
          data: {
            orgId: org.id,
            type: "PAGE",
            name: "Fixture page",
            pageId: `page-${i}`,
          },
        });
      }
      await prisma.webSession.create({
        data: {
          tokenHash: tokenHash(token),
          userId,
          workspaceId: workspaceIds[0],
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      cookieJar.set(SESSION_COOKIE, token);
    });
    afterAll(async () => {
      cookieJar.clear();
      await prisma.metaConnection.deleteMany({
        where: { orgId: { in: orgIds } },
      });
      await prisma.organization.deleteMany({
        where: { id: { in: orgIds } },
      });
      await prisma.requestQuota.deleteMany({
        where: { key: { startsWith: "oauth:" } },
      });
      if (userId) await prisma.user.delete({ where: { id: userId } });
      vi.unstubAllEnvs();
      await prisma.$disconnect();
    });

    it("requires a valid signed webhook payload", async () => {
      const payload = {
        object: "page",
        entry: [
          {
            id: "page-0",
            time: Date.now(),
            changes: [{ value: { leadgen_id: "lg-bad" } }],
          },
        ],
      };
      expect((await webhook(webhookRequest(payload, null))).status).toBe(401);
      expect(
        (await webhook(webhookRequest(payload, sign("wrong", webhookSecret)))).status,
      ).toBe(401);
    });

    it("ingests leadgen idempotently into the owning tenant with encrypted PII", async () => {
      const payload = {
        object: "page",
        entry: [
          {
            id: "page-0",
            time: Date.now(),
            changes: [
              {
                value: {
                  leadgen_id: "lg-1",
                  page_id: "page-0",
                  form_name: "Dental form",
                  field_data: [
                    { name: "email", values: ["guest@example.com"] },
                    { name: "phone_number", values: ["490123456789"] },
                    { name: "first_name", values: ["Ada"] },
                    { name: "last_name", values: ["Yılmaz"] },
                    { name: "country_code", values: ["DE"] },
                  ],
                },
              },
            ],
          },
        ],
      };
      const first = await webhook(webhookRequest(payload, sign(JSON.stringify(payload), webhookSecret)));
      const firstData = await first.json();
      expect(first.status).toBe(200);
      expect(firstData.processed).toBe(1);
      const second = await webhook(webhookRequest(payload, sign(JSON.stringify(payload), webhookSecret)));
      const secondData = await second.json();
      expect(secondData.processed).toBe(0);

      const org1Lead = await prisma.lead.findFirstOrThrow({
        where: { organizationId: orgIds[0], metadata: { path: ["leadgen_id"], equals: "lg-1" } },
      });
      expect(decrypt(org1Lead.phone!)).toBe("490123456789");
      expect(decrypt(org1Lead.email!)).toBe("guest@example.com");
      expect(org1Lead.phone).not.toContain("490123456789");
      expect(org1Lead.lookupHash).toBeTruthy();
      const org1Leads = await prisma.lead.count({ where: { organizationId: orgIds[0] } });
      expect(org1Leads).toBe(1);
      const org2Leads = await prisma.lead.count({ where: { organizationId: orgIds[1] } });
      expect(org2Leads).toBe(0);
    });

    it("routes the same webhook to the other tenant when page belongs there", async () => {
      // Gerçek Messenger biçimi: entry[].messaging[] (Messenger webhook'unda telefon yoktur; lead PSID ile eşleşir).
      const payload = {
        object: "page",
        entry: [
          {
            id: "page-1",
            time: Date.now(),
            messaging: [
              {
                sender: { id: "psid-foreign" },
                recipient: { id: "page-1" },
                timestamp: Date.now(),
                message: { mid: "m-99", text: "Merhaba" },
              },
            ],
          },
        ],
      };
      const res = await webhook(webhookRequest(payload, sign(JSON.stringify(payload), webhookSecret)));
      const data = await res.json();
      expect(res.status).toBe(200);
      expect(data.processed).toBe(1);
      const lead = await prisma.lead.findFirstOrThrow({
        where: { organizationId: orgIds[1], metadata: { path: ["psid"], equals: "psid-foreign" } },
      });
      expect(lead.phone).toBeNull();
      expect(
        await prisma.message.count({ where: { externalId: "m-99", conversation: { leadId: lead.id } } }),
      ).toBe(1);
      expect(
        await prisma.lead.count({ where: { organizationId: orgIds[0] } }),
      ).toBe(1);
      expect(
        await prisma.conversation.count({ where: { leadId: lead.id } }),
      ).toBe(1);
      // Gelen mesaj + otomatik karşılama (mock Messenger gönderimi) = 2 mesaj
      expect(
        await prisma.message.count({ where: { conversation: { leadId: lead.id }, direction: "INCOMING" } }),
      ).toBe(1);
      expect(
        await prisma.message.count({ where: { conversation: { leadId: lead.id }, direction: "OUTGOING" } }),
      ).toBe(1);
    });

    it("sends exactly one WhatsApp message and records one DB message", async () => {
      vi.stubEnv("WHATSAPP_API_URL", "https://graph.whatsapp.test");
      vi.stubEnv("WHATSAPP_TOKEN", "test-token");
      // Gerçek gönderim doğrulanıyor: mock modu yalnızca bu test için kapatılır.
      loadEnv({ fresh: true, overrides: { META_MOCK_MODE: "false" } });
      const lead = await prisma.lead.create({
        data: {
          workspaceId: workspaceIds[0],
          organizationId: orgIds[0],
          firstName: "Senda",
          lastName: "Test",
          phone: encrypt("490000111222"),
          channel: "WHATSAPP",
          status: "NEW",
          language: "tr",
        },
      });
      const conv = await prisma.conversation.create({
        data: {
          leadId: lead.id,
          workspaceId: workspaceIds[0],
          channel: "WHATSAPP",
          status: "ACTIVE",
        },
      });
      await prisma.message.create({
        data: {
          conversationId: conv.id,
          direction: "INCOMING",
          channel: "WHATSAPP",
          content: "merhaba",
          sender: "external",
        },
      });
      const spy = vi.spyOn(globalThis, "fetch");
      spy.mockResolvedValue(
        new Response(JSON.stringify({ messages: [{ id: "wamid-1" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      const body = JSON.stringify({ content: "Merhaba, nasılsınız?" });
      const req = new Request(
        "http://localhost:3000/api/leads/x/messages",
        {
          method: "POST",
          headers: {
            origin: "http://localhost:3000",
            "content-type": "application/json",
          },
          body,
        },
      );
      try {
        const res = await sendMessage(req, { params: Promise.resolve({ id: conv.id }) });
        expect(res.status).toBe(200);
        const sent = spy.mock.calls.filter(
          (c) => String(c[0]).startsWith("https://graph.whatsapp.test"),
        );
        expect(sent).toHaveLength(1);
        const sentBody = JSON.parse(String((sent[0][1] as RequestInit)?.body));
        expect(sentBody.text.body).toBe("Merhaba, nasılsınız?");
        expect(
          await prisma.message.count({ where: { conversationId: conv.id } }),
        ).toBe(2);
        expect(
          await prisma.auditLog.count({
            where: { action: "MESSAGE_SENT", entityId: conv.id },
          }),
        ).toBe(1);
      } finally {
        spy.mockRestore();
        vi.unstubAllEnvs();
        loadEnv({ fresh: true });
      }
    });

    it("blocks free-form text outside the 24h window", async () => {
      const lead = await prisma.lead.create({
        data: {
          workspaceId: workspaceIds[0],
          organizationId: orgIds[0],
          firstName: "Window",
          lastName: "Test",
          phone: encrypt("490000333444"),
          channel: "WHATSAPP",
          status: "NEW",
        },
      });
      const conv = await prisma.conversation.create({
        data: {
          leadId: lead.id,
          workspaceId: workspaceIds[0],
          channel: "WHATSAPP",
          status: "ACTIVE",
        },
      });
      const req = new Request("http://localhost:3000/api/leads/x/messages", {
        method: "POST",
        headers: { origin: "http://localhost:3000", "content-type": "application/json" },
        body: JSON.stringify({ content: "Merhaba" }),
      });
      const res = await sendMessage(req, { params: Promise.resolve({ id: conv.id }) });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("pencere");
    });

    it("restricts escalated conversations to owner/admin", async () => {
      const lead = await prisma.lead.create({
        data: {
          workspaceId: workspaceIds[0],
          organizationId: orgIds[0],
          firstName: "Esc",
          lastName: "Test",
          channel: "MESSENGER",
          status: "NEW",
        },
      });
      const conv = await prisma.conversation.create({
        data: {
          leadId: lead.id,
          workspaceId: workspaceIds[0],
          channel: "MESSENGER",
          status: "ESCALATED",
          escalatedTo: userId,
        },
      });
      await prisma.membership.update({
        where: { orgId_userId: { orgId: orgIds[0], userId } },
        data: { role: "MEDIA_BUYER" },
      });
      const req = (body: unknown) =>
        new Request("http://localhost:3000/api/leads/x/messages", {
          method: "POST",
          headers: { origin: "http://localhost:3000", "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      try {
        const denied = await sendMessage(req({ content: "Hayır", channel: "MESSENGER" }), {
          params: Promise.resolve({ id: conv.id }),
        });
        expect(denied.status).toBe(403);
        await prisma.membership.update({
          where: { orgId_userId: { orgId: orgIds[0], userId } },
          data: { role: "OWNER" },
        });
        const allowed = await sendMessage(req({ content: "Evet", channel: "MESSENGER" }), {
          params: Promise.resolve({ id: conv.id }),
        });
        expect(allowed.status).toBe(200);
        expect(
          await prisma.message.count({ where: { conversationId: conv.id } }),
        ).toBe(1);
      } finally {
        await prisma.membership.update({
          where: { orgId_userId: { orgId: orgIds[0], userId } },
          data: { role: "OWNER" },
        });
      }
    });
  },
);
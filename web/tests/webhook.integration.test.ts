import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHmac, randomBytes } from "node:crypto";
import { prisma } from "@admedic/database";
import { decrypt } from "../app/_lib/encrypt";
import { BOT_DISCLOSURE, inferFromPhone, normalizeCountry } from "../app/_lib/webhook-ingest";
import { GET, POST } from "../app/api/webhooks/meta/route";
import { POST as legacyPost } from "../app/api/leads/[id]/webhook/route";

const WEBHOOK_URL = "http://localhost:3000/api/webhooks/meta";

function sign(payload: string, secret: string) {
  return "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
}

function signedRequest(payload: unknown, secret: string) {
  const body = JSON.stringify(payload);
  return new Request(WEBHOOK_URL, {
    method: "POST",
    body,
    headers: { "x-hub-signature-256": sign(body, secret), "content-type": "application/json" },
  });
}

function unsignedRequest(payload: unknown, signature?: string) {
  return new Request(WEBHOOK_URL, {
    method: "POST",
    body: JSON.stringify(payload),
    headers: signature
      ? { "x-hub-signature-256": signature, "content-type": "application/json" }
      : { "content-type": "application/json" },
  });
}

function verifyRequest(params: Record<string, string>) {
  const url = new URL(WEBHOOK_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Request(url.toString(), { method: "GET" });
}

describe("webhook saf yardımcıları", () => {
  it("telefon önekinden ülke ve dil türetir", () => {
    expect(inferFromPhone("+90 532 111 22 33")).toEqual({ country: "TR", language: "tr" });
    expect(inferFromPhone("4915112345678")).toEqual({ country: "DE", language: "de" });
    expect(inferFromPhone("447700900123")).toEqual({ country: "GB", language: "en" });
    expect(inferFromPhone("79161234567")).toEqual({ country: "RU", language: "ru" });
    expect(inferFromPhone("77011234567")).toEqual({ country: "KZ", language: "ru" });
    expect(inferFromPhone("966501234567")).toEqual({ country: "SA", language: "ar" });
    expect(inferFromPhone("971501234567")).toEqual({ country: "AE", language: "ar" });
    expect(inferFromPhone("33612345678")).toEqual({ country: "FR", language: "fr" });
    expect(inferFromPhone("31612345678")).toEqual({ country: "NL", language: "nl" });
    expect(inferFromPhone("48501234567")).toEqual({ country: "PL", language: "pl" });
    expect(inferFromPhone("")).toBeNull();
    expect(inferFromPhone("12")).toBeNull();
  });
  it("ülke adlarını ISO-2 koda indirger", () => {
    expect(normalizeCountry("de")).toBe("DE");
    expect(normalizeCountry("Germany")).toBe("DE");
    expect(normalizeCountry("United Kingdom")).toBe("GB");
    expect(normalizeCountry("Atlantis")).toBeNull();
  });
});

describe.skipIf(process.env.STUDIO_DB_TEST !== "1")("meta webhook integration", () => {
  const suffix = randomBytes(6).toString("hex");
  const secret = randomBytes(16).toString("hex");
  const verifyToken = randomBytes(12).toString("hex");
  const pageA = `pg-${suffix}-a`;
  const igA = `ig-${suffix}-a`;
  const phoneNumberIdA = `pn-${suffix}-a`;
  const wabaA = `waba-${suffix}-a`;
  const pageB = `pg-${suffix}-b`;
  const orgIds: string[] = [];
  const workspaceIds: string[] = [];

  beforeAll(async () => {
    vi.stubEnv("META_WEBHOOK_SECRET", secret);
    vi.stubEnv("META_WEBHOOK_VERIFY_TOKEN", verifyToken);
    vi.stubEnv("WHATSAPP_GREETING_TEMPLATE", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("LLM_MODEL", "");
    for (const key of ["a", "b"]) {
      const org = await prisma.organization.create({
        data: {
          name: `Webhook fixture ${key}`,
          slug: `whfix-${suffix}-${key}`,
          workspaces: { create: { name: "Fixture", slug: "main" } },
        },
        include: { workspaces: true },
      });
      orgIds.push(org.id);
      workspaceIds.push(org.workspaces[0]!.id);
    }
    // Tenant A: sayfa + Instagram + WhatsApp; klinik dili DE (Messenger varsayılanı için).
    await prisma.metaConnection.create({
      data: { orgId: orgIds[0]!, type: "PAGE", name: "Fixture page A", pageId: pageA, instaId: igA },
    });
    await prisma.metaConnection.create({
      data: {
        orgId: orgIds[0]!,
        type: "WHATSAPP_BUSINESS",
        name: "Fixture WABA A",
        whatsappPhoneNumberId: phoneNumberIdA,
        whatsappBusinessId: wabaA,
      },
    });
    await prisma.clinicProfile.create({
      data: {
        workspaceId: workspaceIds[0]!,
        name: "Fixture Klinik",
        slug: `fixture-${suffix}`,
        languages: ["DE", "EN"],
      },
    });
    // Tenant B: yalnızca sayfa; A'ya gelen hiçbir olay B'ye yazılmamalı.
    await prisma.metaConnection.create({
      data: { orgId: orgIds[1]!, type: "PAGE", name: "Fixture page B", pageId: pageB },
    });
  });

  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
    vi.unstubAllEnvs();
    await prisma.$disconnect();
  });

  it("GET abonelik doğrulaması: doğru token → challenge, yanlış → 403, env yoksa → 503", async () => {
    const ok = await GET(
      verifyRequest({ "hub.mode": "subscribe", "hub.verify_token": verifyToken, "hub.challenge": "1158201444" }),
    );
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("1158201444");
    expect(ok.headers.get("content-type")).toContain("text/plain");

    const bad = await GET(
      verifyRequest({ "hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "1" }),
    );
    expect(bad.status).toBe(403);
    const wrongMode = await GET(
      verifyRequest({ "hub.mode": "unsubscribe", "hub.verify_token": verifyToken, "hub.challenge": "1" }),
    );
    expect(wrongMode.status).toBe(403);

    vi.stubEnv("META_WEBHOOK_VERIFY_TOKEN", "");
    try {
      const missing = await GET(
        verifyRequest({ "hub.mode": "subscribe", "hub.verify_token": verifyToken, "hub.challenge": "1" }),
      );
      expect(missing.status).toBe(503);
    } finally {
      vi.stubEnv("META_WEBHOOK_VERIFY_TOKEN", verifyToken);
    }
  });

  it("imzasız / yanlış imzalı POST 401 döner ve hiçbir şey yazmaz", async () => {
    const payload = {
      object: "page",
      entry: [{ id: pageA, time: Date.now(), changes: [{ field: "leadgen", value: { leadgen_id: `lg-unsigned-${suffix}` } }] }],
    };
    expect((await POST(unsignedRequest(payload))).status).toBe(401);
    expect((await POST(unsignedRequest(payload, sign("other", secret)))).status).toBe(401);
    expect((await POST(unsignedRequest(payload, "sha1=abc"))).status).toBe(401);
    expect(
      await prisma.lead.count({ where: { organizationId: orgIds[0]!, leadgenId: `lg-unsigned-${suffix}` } }),
    ).toBe(0);
  });

  it("gerçek biçimde leadgen (field_data ile): şifreli PII, kimlikler, idempotent tekrar ve duplicate marker", async () => {
    const leadgenId = `lg-${suffix}-1`;
    const payload = {
      object: "page",
      entry: [
        {
          id: pageA,
          time: Date.now(),
          changes: [
            {
              field: "leadgen",
              value: {
                leadgen_id: leadgenId,
                page_id: pageA,
                form_id: "form-1",
                ad_id: "ad-11",
                adgroup_id: "ad-11",
                adset_id: "adset-22",
                campaign_id: "cmp-33",
                created_time: 1758870000,
                field_data: [
                  { name: "email", values: ["Guest@Example.com"] },
                  { name: "phone_number", values: ["+49 151 2345678"] },
                  { name: "full_name", values: ["Ada Yılmaz"] },
                  { name: "country", values: ["Germany"] },
                  { name: "which_treatment_are_you_interested_in?", values: ["Saç ekimi"] },
                ],
              },
            },
          ],
        },
      ],
    };
    const first = await POST(signedRequest(payload, secret));
    expect(first.status).toBe(200);
    const firstData = await first.json();
    expect(firstData).toMatchObject({ received: true, processed: 1, duplicates: 0, ignoredPages: 0 });
    expect(firstData.duplicate).toBeUndefined();

    const lead = await prisma.lead.findUniqueOrThrow({
      where: { organizationId_leadgenId: { organizationId: orgIds[0]!, leadgenId } },
      include: { conversations: { include: { messages: true } } },
    });
    expect(lead.workspaceId).toBe(workspaceIds[0]);
    expect(decrypt(lead.email!)).toBe("Guest@Example.com");
    expect(decrypt(lead.phone!)).toBe("+49 151 2345678");
    expect(lead.email).not.toContain("Example");
    expect(lead.phone).not.toContain("2345678");
    expect(lead.firstName).toBe("Ada");
    expect(lead.lastName).toBe("Yılmaz");
    expect(lead.channel).toBe("LEAD_AD");
    expect(lead.country).toBe("DE");
    expect(lead.language).toBe("de");
    expect(lead.adId).toBe("ad-11");
    expect(lead.adSetId).toBe("adset-22");
    expect(lead.campaignId).toBe("cmp-33");
    expect(lead.interestedService).toBe("Saç ekimi");
    expect(lead.lookupHash).toBeTruthy();
    expect(lead.duplicateOf).toBeNull();
    const meta = lead.metadata as Record<string, unknown>;
    expect(meta.leadgen_id).toBe(leadgenId);
    expect(meta.source).toBe("lead_ads");
    expect(meta.form_id).toBe("form-1");
    expect(meta.pendingGreeting).toBe(true);
    // PII metadata'da bulunmaz; PII olmayan yanıtlar answers altında kalır.
    const flat = JSON.stringify(meta).toLowerCase();
    expect(flat).not.toContain("example.com");
    expect(flat).not.toContain("2345678");
    expect(flat).not.toContain("yılmaz");
    expect(meta).not.toHaveProperty("email");
    expect(meta).not.toHaveProperty("phone_number");
    expect(meta).not.toHaveProperty("fields");
    expect((meta.answers as Record<string, string>)["which_treatment_are_you_interested_in?"]).toBe("Saç ekimi");
    // Telefonu var: WhatsApp konuşması açılır ama şablon yokken gönderim yapılmaz.
    expect(lead.conversations).toHaveLength(1);
    expect(lead.conversations[0]!.channel).toBe("WHATSAPP");
    expect(lead.conversations[0]!.firstResponseAt).toBeNull();
    expect(lead.conversations[0]!.messages).toHaveLength(0);
    expect(
      await prisma.auditLog.count({
        where: { orgId: orgIds[0]!, action: "LEAD_INGESTED", entityId: lead.id, userId: null },
      }),
    ).toBe(1);

    // Aynı leadgen_id yeniden teslim → duplicate, ikinci lead yok.
    const second = await POST(signedRequest(payload, secret));
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ received: true, processed: 0, duplicates: 1, duplicate: true });
    expect(await prisma.lead.count({ where: { organizationId: orgIds[0]!, leadgenId } })).toBe(1);
    expect(await prisma.lead.count({ where: { organizationId: orgIds[1]! } })).toBe(0);

    // Aynı kişi (telefon) farklı bir formdan → yeni lead duplicateOf ile, audit LEAD_DUPLICATE_MARKED.
    const dupId = `lg-${suffix}-2`;
    const dupPayload = {
      object: "page",
      entry: [
        {
          id: pageA,
          time: Date.now(),
          changes: [
            {
              field: "leadgen",
              value: {
                leadgen_id: dupId,
                page_id: pageA,
                form_id: "form-2",
                ad_id: "ad-12",
                created_time: 1758870100,
                field_data: [
                  { name: "phone_number", values: ["0049 151 2345678"] },
                  { name: "first_name", values: ["Ada"] },
                  { name: "last_name", values: ["Y."] },
                ],
              },
            },
          ],
        },
      ],
    };
    expect((await POST(signedRequest(dupPayload, secret))).status).toBe(200);
    const duplicate = await prisma.lead.findUniqueOrThrow({
      where: { organizationId_leadgenId: { organizationId: orgIds[0]!, leadgenId: dupId } },
    });
    expect(duplicate.id).not.toBe(lead.id);
    expect(duplicate.duplicateOf).toBe(lead.id);
    expect(duplicate.lookupHash).toBeNull();
    const marked = await prisma.auditLog.findFirst({
      where: { action: "LEAD_DUPLICATE_MARKED", entityId: duplicate.id },
    });
    expect(marked).not.toBeNull();
    expect(marked!.userId).toBeNull();
    expect(marked!.orgId).toBe(orgIds[0]);
    expect(marked!.workspaceId).toBe(workspaceIds[0]);
    expect((marked!.after as Record<string, unknown>).duplicateOf).toBe(lead.id);
  });

  it("yalnızca kimlik taşıyan gerçek leadgen webhook'u mock modda sahte veriyle doldurulur ve sayısal kimlikleri kabul eder", async () => {
    const payload = {
      object: "page",
      entry: [
        {
          id: pageA,
          time: 1758870000,
          changes: [
            {
              field: "leadgen",
              value: {
                leadgen_id: 987654321012345,
                page_id: 153125381133,
                form_id: 12312312312,
                adgroup_id: 12312312312,
                ad_id: 12312312312,
                created_time: 1758870000,
              },
            },
          ],
        },
      ],
    };
    const res = await POST(signedRequest(payload, secret));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ processed: 1 });
    const lead = await prisma.lead.findUniqueOrThrow({
      where: { organizationId_leadgenId: { organizationId: orgIds[0]!, leadgenId: "987654321012345" } },
    });
    expect(lead.email).toBeTruthy();
    expect(decrypt(lead.email!)).toContain("@example.invalid");
    expect(lead.phone).toBeTruthy();
    expect(lead.adId).toBeTruthy();
    expect((lead.metadata as Record<string, unknown>).data_source).toBe("mock");
    expect((lead.metadata as Record<string, unknown>).page_id).toBe("153125381133");
  });

  it("WHATSAPP_GREETING_TEMPLATE varsa lead ads karşılaması şablonla gönderilir ve firstResponseAt yazılır", async () => {
    vi.stubEnv("WHATSAPP_GREETING_TEMPLATE", "welcome_v1");
    const leadgenId = `lg-${suffix}-tpl`;
    try {
      const payload = {
        object: "page",
        entry: [
          {
            id: pageA,
            time: Date.now(),
            changes: [
              {
                field: "leadgen",
                value: {
                  leadgen_id: leadgenId,
                  page_id: pageA,
                  field_data: [
                    { name: "phone_number", values: ["+90 532 999 88 77"] },
                    { name: "first_name", values: ["Ayşe"] },
                  ],
                },
              },
            ],
          },
        ],
      };
      expect((await POST(signedRequest(payload, secret))).status).toBe(200);
    } finally {
      vi.stubEnv("WHATSAPP_GREETING_TEMPLATE", "");
    }
    const lead = await prisma.lead.findUniqueOrThrow({
      where: { organizationId_leadgenId: { organizationId: orgIds[0]!, leadgenId } },
      include: { conversations: { include: { messages: true } } },
    });
    expect(lead.language).toBe("tr");
    expect(lead.country).toBe("TR");
    expect((lead.metadata as Record<string, unknown>).pendingGreeting).toBe(false);
    const conversation = lead.conversations[0]!;
    expect(conversation.firstResponseAt).not.toBeNull();
    expect(conversation.messages).toHaveLength(1);
    const outgoing = conversation.messages[0]!;
    expect(outgoing.direction).toBe("OUTGOING");
    expect(outgoing.sender).toBe("bot");
    const meta = outgoing.metadata as Record<string, unknown>;
    expect(meta.whatsappTemplate).toBe("welcome_v1");
    expect((meta.whatsappResult as Record<string, unknown>).id).toMatch(/^mock_/);
    expect(meta.deliveryError).toBeUndefined();
    expect(
      await prisma.auditLog.count({ where: { action: "AUTO_GREETING_SENT", entityId: conversation.id } }),
    ).toBe(1);
  });

  it("Messenger entry.messaging: lead + konuşma + mesaj, karşılama, aynı mid tekrar tek mesaj, ikinci mesajda bot susar", async () => {
    const psid = `psid-${suffix}`;
    const mid = `m_${suffix}_1`;
    const payload = {
      object: "page",
      entry: [
        {
          id: pageA,
          time: Date.now(),
          messaging: [
            {
              sender: { id: psid },
              recipient: { id: pageA },
              timestamp: Date.now(),
              message: {
                mid,
                text: "Merhaba, saç ekimi hakkında bilgi alabilir miyim?",
                referral: { ad_id: "ad-ctm-1", source: "ADS", type: "OPEN_THREAD" },
              },
            },
            // read / delivery olayları ve echo yok sayılır
            { sender: { id: psid }, recipient: { id: pageA }, timestamp: Date.now(), read: { watermark: 1 } },
            {
              sender: { id: pageA },
              recipient: { id: psid },
              timestamp: Date.now(),
              message: { mid: `m_${suffix}_echo`, text: "echo", is_echo: true },
            },
          ],
        },
      ],
    };
    const res = await POST(signedRequest(payload, secret));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ processed: 1, ignored: 2, ignoredPages: 0 });

    const lead = await prisma.lead.findFirstOrThrow({
      where: { organizationId: orgIds[0]!, channel: "MESSENGER", metadata: { path: ["psid"], equals: psid } },
      include: { conversations: { include: { messages: { orderBy: { createdAt: "asc" } } } } },
    });
    expect(lead.firstName).toBe("Konuk");
    expect(lead.language).toBe("de"); // klinik dili (ClinicProfile.languages[0])
    expect(lead.adId).toBe("ad-ctm-1");
    expect(lead.phone).toBeNull();
    const meta = lead.metadata as Record<string, unknown>;
    expect(meta.page_id).toBe(pageA);
    expect(meta.mid).toBe(mid);
    expect(lead.conversations).toHaveLength(1);
    const conversation = lead.conversations[0]!;
    expect(conversation.channel).toBe("MESSENGER");
    expect(conversation.status).toBe("ACTIVE");
    expect(conversation.firstResponseAt).not.toBeNull();
    expect(conversation.messages).toHaveLength(2);
    const incoming = conversation.messages[0]!;
    expect(incoming.direction).toBe("INCOMING");
    expect(incoming.externalId).toBe(mid);
    expect((incoming.metadata as Record<string, unknown>).mid).toBe(mid);
    const greeting = conversation.messages[1]!;
    expect(greeting.direction).toBe("OUTGOING");
    expect(greeting.channel).toBe("MESSENGER");
    expect(greeting.content).toContain(BOT_DISCLOSURE.de);
    expect((greeting.metadata as Record<string, unknown>).autoGreet).toBe(true);
    expect(((greeting.metadata as Record<string, unknown>).messengerResult as Record<string, unknown>).id).toMatch(/^mock_/);

    // Aynı mid tekrar → duplicate, mesaj sayısı değişmez.
    const again = await POST(signedRequest(payload, secret));
    expect(await again.json()).toMatchObject({ processed: 0, duplicates: 1, duplicate: true });
    expect(await prisma.message.count({ where: { conversationId: conversation.id } })).toBe(2);

    // Bot devredeyken ikinci mesaj yalnızca kaydedilir; otomatik yanıt üretilmez.
    const followUp = {
      object: "page",
      entry: [
        {
          id: pageA,
          time: Date.now(),
          messaging: [
            {
              sender: { id: psid },
              recipient: { id: pageA },
              timestamp: Date.now(),
              message: { mid: `m_${suffix}_2`, attachments: [{ type: "image", payload: { url: "https://x.test/i.jpg" } }] },
            },
          ],
        },
      ],
    };
    expect(await (await POST(signedRequest(followUp, secret))).json()).toMatchObject({ processed: 1 });
    const messages = await prisma.message.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: "asc" },
    });
    expect(messages).toHaveLength(3);
    expect(messages[2]!.direction).toBe("INCOMING");
    expect(messages[2]!.content).toContain("image");
    expect(await prisma.conversation.count({ where: { leadId: lead.id } })).toBe(1);
  });

  it("eşzamanlı teslimatlar tek lead/konuşma üretir; aynı mid yalnızca bir kez yazılır", async () => {
    const psid = `psid-${suffix}-race`;
    const event = (mid: string) => ({
      object: "page",
      entry: [
        {
          id: pageA,
          time: Date.now(),
          messaging: [
            { sender: { id: psid }, recipient: { id: pageA }, timestamp: Date.now(), message: { mid, text: "hallo" } },
          ],
        },
      ],
    });
    const same = event(`m_${suffix}_race_1`);
    const results = await Promise.all([
      POST(signedRequest(same, secret)),
      POST(signedRequest(same, secret)),
      POST(signedRequest(event(`m_${suffix}_race_2`), secret)),
    ]);
    for (const r of results) expect(r.status).toBe(200);
    const leads = await prisma.lead.findMany({
      where: { organizationId: orgIds[0]!, metadata: { path: ["psid"], equals: psid } },
      include: { conversations: { include: { messages: true } } },
    });
    expect(leads).toHaveLength(1);
    expect(leads[0]!.conversations).toHaveLength(1);
    const incoming = leads[0]!.conversations[0]!.messages.filter((m) => m.direction === "INCOMING");
    expect(incoming.map((m) => m.externalId).sort()).toEqual([`m_${suffix}_race_1`, `m_${suffix}_race_2`]);
    // Karşılama en fazla bir kez gönderilir.
    expect(leads[0]!.conversations[0]!.messages.filter((m) => m.direction === "OUTGOING")).toHaveLength(1);
  });

  it("Instagram object: instaId ile tenant çözülür ve INSTAGRAM kanalı açılır", async () => {
    const igUser = `igu-${suffix}`;
    const payload = {
      object: "instagram",
      entry: [
        {
          id: igA,
          time: Date.now(),
          messaging: [
            {
              sender: { id: igUser },
              recipient: { id: igA },
              timestamp: Date.now(),
              message: { mid: `ig_${suffix}_1`, text: "Hi, do you offer dental implants?" },
            },
          ],
        },
      ],
    };
    const res = await POST(signedRequest(payload, secret));
    expect(await res.json()).toMatchObject({ processed: 1, ignoredPages: 0 });
    const lead = await prisma.lead.findFirstOrThrow({
      where: { organizationId: orgIds[0]!, channel: "INSTAGRAM", metadata: { path: ["psid"], equals: igUser } },
      include: { conversations: { include: { messages: true } } },
    });
    expect((lead.metadata as Record<string, unknown>).page_id).toBe(igA);
    expect(lead.conversations[0]!.channel).toBe("INSTAGRAM");
    expect(lead.conversations[0]!.messages.some((m) => m.direction === "INCOMING" && m.externalId === `ig_${suffix}_1`)).toBe(true);
    expect(lead.conversations[0]!.messages.some((m) => m.direction === "OUTGOING")).toBe(true);
  });

  it("aynı sayfa kimliği iki organizasyonda kayıtlıysa olay hiçbir tenant'a yazılmaz (fail-closed)", async () => {
    const sharedPage = `shared-page-${suffix}`;
    const rows = await Promise.all(
      orgIds.map((orgId, i) =>
        prisma.metaConnection.create({
          data: { orgId, type: "BUSINESS_MANAGER", name: `manual ${i}`, pageId: sharedPage, status: "CONNECTED" },
        }),
      ),
    );
    try {
      const psid = `psid-shared-${suffix}`;
      const payload = {
        object: "page",
        entry: [
          {
            id: sharedPage,
            time: Date.now(),
            messaging: [{ sender: { id: psid }, recipient: { id: sharedPage }, timestamp: Date.now(), message: { mid: `shared_${suffix}`, text: "merhaba" } }],
          },
        ],
      };
      const res = await POST(signedRequest(payload, secret));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ processed: 0 });
      expect(await prisma.lead.count({ where: { metadata: { path: ["psid"], equals: psid } } })).toBe(0);
      expect(await prisma.message.count({ where: { externalId: `shared_${suffix}` } })).toBe(0);
    } finally {
      await prisma.metaConnection.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
    }
  });

  it("WhatsApp whatsapp_business_account: phone_number_id ile tenant, şifreli numara, karşılama OUTGOING (mock), statuses yok sayılır", async () => {
    const waId = `90532${suffix.slice(0, 7).replace(/[a-f]/g, "1")}`;
    const wamid = `wamid.${suffix}.1`;
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: wabaA,
          changes: [
            {
              value: {
                messaging_product: "whatsapp",
                metadata: { display_phone_number: "905000000000", phone_number_id: phoneNumberIdA },
                contacts: [{ profile: { name: "Ayşe Kaya" }, wa_id: waId }],
                messages: [
                  {
                    from: waId,
                    id: wamid,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: "text",
                    text: { body: "Merhaba, fiyat bilgisi alabilir miyim?" },
                    referral: {
                      source_url: "https://fb.me/ad",
                      source_type: "ad",
                      source_id: "ad-ctwa-9",
                      headline: "Saç ekimi",
                      body: "Ücretsiz konsültasyon",
                      media_type: "image",
                      ctwa_clid: "clid-1",
                    },
                  },
                ],
              },
              field: "messages",
            },
          ],
        },
      ],
    };
    const res = await POST(signedRequest(payload, secret));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ processed: 1, ignoredPages: 0 });

    const lead = await prisma.lead.findFirstOrThrow({
      where: { organizationId: orgIds[0]!, channel: "WHATSAPP" },
      include: { conversations: { include: { messages: { orderBy: { createdAt: "asc" } } } } },
    });
    expect(decrypt(lead.phone!)).toBe(waId);
    expect(lead.firstName).toBe("Ayşe");
    expect(lead.lastName).toBe("Kaya");
    expect(lead.language).toBe("tr");
    expect(lead.country).toBe("TR");
    expect(lead.adId).toBe("ad-ctwa-9");
    const meta = lead.metadata as Record<string, unknown>;
    expect(JSON.stringify(meta)).not.toContain(waId);
    expect(JSON.stringify(meta)).not.toContain("Kaya");
    expect(meta.phone_number_id).toBe(phoneNumberIdA);
    expect(meta).not.toHaveProperty("psid");

    const conversation = lead.conversations[0]!;
    expect(conversation.channel).toBe("WHATSAPP");
    expect(conversation.firstResponseAt).not.toBeNull();
    expect(conversation.messages).toHaveLength(2);
    const incoming = conversation.messages[0]!;
    expect(incoming.externalId).toBe(wamid);
    expect(incoming.sender).toBe("external");
    expect((incoming.metadata as Record<string, unknown>).wamid).toBe(wamid);
    const greeting = conversation.messages[1]!;
    expect(greeting.direction).toBe("OUTGOING");
    expect(greeting.content).toContain(BOT_DISCLOSURE.tr);
    const gm = greeting.metadata as Record<string, unknown>;
    expect((gm.whatsappResult as Record<string, unknown>).id).toMatch(/^mock_/);
    expect(gm.deliveryError).toBeUndefined();

    // statuses → 200, kayıt yok
    const statuses = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: wabaA,
          changes: [
            {
              value: {
                messaging_product: "whatsapp",
                metadata: { display_phone_number: "905000000000", phone_number_id: phoneNumberIdA },
                statuses: [{ id: wamid, status: "read", timestamp: "1758870000", recipient_id: waId }],
              },
              field: "messages",
            },
          ],
        },
      ],
    };
    const statusRes = await POST(signedRequest(statuses, secret));
    expect(statusRes.status).toBe(200);
    expect(await statusRes.json()).toMatchObject({ processed: 0, ignored: 1 });
    expect(await prisma.message.count({ where: { conversationId: conversation.id } })).toBe(2);

    // Aynı wamid tekrar → duplicate
    expect(await (await POST(signedRequest(payload, secret))).json()).toMatchObject({ duplicates: 1, duplicate: true });
    expect(await prisma.message.count({ where: { conversationId: conversation.id } })).toBe(2);
  });

  it("bilinmeyen sayfa/numara hiçbir yazma yapmaz; bilinmeyen biçim 200 ignored döner", async () => {
    const before = await prisma.lead.count();
    const unknownPage = {
      object: "page",
      entry: [
        {
          id: `pg-${suffix}-unknown`,
          time: Date.now(),
          changes: [{ field: "leadgen", value: { leadgen_id: `lg-${suffix}-unknown`, page_id: `pg-${suffix}-unknown` } }],
          messaging: [{ sender: { id: "x" }, recipient: { id: "y" }, message: { mid: `m_${suffix}_unknown`, text: "hi" } }],
        },
      ],
    };
    const res = await POST(signedRequest(unknownPage, secret));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ processed: 0, ignoredPages: 1 });
    const unknownNumber = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: `waba-${suffix}-unknown`,
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { display_phone_number: "1", phone_number_id: `pn-${suffix}-unknown` },
                contacts: [{ profile: { name: "X" }, wa_id: "15550001111" }],
                messages: [{ from: "15550001111", id: `wamid.${suffix}.unknown`, type: "text", text: { body: "hi" } }],
              },
            },
          ],
        },
      ],
    };
    expect(await (await POST(signedRequest(unknownNumber, secret))).json()).toMatchObject({ processed: 0, ignoredPages: 1 });
    expect(await prisma.lead.count()).toBe(before);
    expect(await prisma.message.count({ where: { externalId: `m_${suffix}_unknown` } })).toBe(0);

    for (const body of [{ object: "user", entry: [{ id: "1", changes: [] }] }, { hello: "world" }, [1, 2, 3]]) {
      const ignored = await POST(signedRequest(body, secret));
      expect(ignored.status).toBe(200);
      expect(await ignored.json()).toMatchObject({ received: true, ignored: true });
    }
    const invalidJson = new Request(WEBHOOK_URL, {
      method: "POST",
      body: "not-json",
      headers: { "x-hub-signature-256": sign("not-json", secret) },
    });
    const invalid = await POST(invalidJson);
    expect(invalid.status).toBe(200);
    expect(await invalid.json()).toMatchObject({ ignored: true, reason: "invalid_json" });
  });

  it("eski yol api/leads/[id]/webhook aynı handler'ı sunar", async () => {
    const payload = {
      object: "page",
      entry: [
        {
          id: pageA,
          time: Date.now(),
          changes: [
            {
              field: "leadgen",
              value: {
                leadgen_id: `lg-${suffix}-legacy`,
                page_id: pageA,
                field_data: [{ name: "email", values: [`legacy-${suffix}@example.invalid`] }],
              },
            },
          ],
        },
      ],
    };
    const res = await legacyPost(signedRequest(payload, secret));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ processed: 1 });
    const lead = await prisma.lead.findUniqueOrThrow({
      where: { organizationId_leadgenId: { organizationId: orgIds[0]!, leadgenId: `lg-${suffix}-legacy` } },
      include: { conversations: true },
    });
    expect(decrypt(lead.email!)).toBe(`legacy-${suffix}@example.invalid`);
    // Telefon yok → konuşma açılmaz, karşılama beklemede.
    expect(lead.conversations).toHaveLength(0);
    expect((lead.metadata as Record<string, unknown>).pendingGreeting).toBe(true);
    expect((await legacyPost(unsignedRequest(payload))).status).toBe(401);
  });
});

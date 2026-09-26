import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { randomBytes } from "node:crypto";

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

import { prisma } from "@admedic/database";
import {
  currentActor,
  requireActor,
  SESSION_COOKIE,
  type Actor,
} from "../app/_lib/auth";
import { tokenHash, hashPassword } from "../app/_lib/password";
import {
  createDraft,
  getDraft,
  changeDraft,
  getExperiment,
  updateExperiment,
  enrichBriefWithProfile,
} from "../app/_lib/studio-service";
import { POST as login, DELETE as logout } from "../app/api/session/route";
import { POST as generate } from "../app/api/studio/generate/route";
import { PATCH as patchDraft } from "../app/api/studio/[id]/route";
import { GET as listDrafts } from "../app/api/studio/route";
import { BriefSchema, type DraftContent } from "@admedic/llm";
import type { Metrics } from "../app/_lib/experiment";

const policyResponse = (risk: string, reason: string) =>
  Response.json({
    stop_reason: "end_turn",
    content: [{ type: "text", text: JSON.stringify({ risk, reason, correctedCopy: "Düzeltilmiş metin." }) }],
    usage: { input_tokens: 3, output_tokens: 4 },
  });
const creativeResponse = () =>
  Response.json({
    stop_reason: "end_turn",
    content: [
      {
        type: "text",
        text: JSON.stringify({
          variants: [
            { headline: "Meet the team", text: "Contact our team for service information.", cta: "Learn more" },
            { headline: "Discover services", text: "Contact our team for service information.", cta: "Learn more" },
          ],
          instantForm: { questions: ["Which service?", "Your country?"] },
          whatsapp: { welcome: "Merhaba! Ben otomatik asistanım; hangi hizmetle ilgileniyorsunuz?" },
        }),
      },
    ],
    usage: { input_tokens: 20, output_tokens: 30 },
  });

// Explicit opt-in: unique fixtures only; no reset, no existing rows modified.
describe.skipIf(process.env.STUDIO_DB_TEST !== "1")(
  "studio database isolation and workflow",
  () => {
    const suffix = randomBytes(8).toString("hex");
    const password = randomBytes(24).toString("hex");
    const email = `fixture-${suffix}@example.invalid`;
    const token = randomBytes(32).toString("hex");
    let owner: Actor;
    let other: Actor;
    let userId: string;
    const orgIds: string[] = [];
    const content: DraftContent = {
      clinic: "Fixture clinic",
      service: "Services",
      market: "UK",
      language: "EN",
      budget: 700,
      duration: 7,
      variants: [
        {
          headline: "Meet the team",
          text: "Contact our team for service information.",
          cta: "Learn more",
        },
        {
          headline: "Discover services",
          text: "Contact our team for service information.",
          cta: "Learn more",
        },
      ],
    };
    beforeAll(async () => {
      const user = await prisma.user.create({
        data: { email, passwordHash: await hashPassword(password) },
      });
      userId = user.id;
      for (let i = 0; i < 2; i++) {
        const org = await prisma.organization.create({
          data: {
            name: "Integration fixture",
            slug: `fixture-${suffix}-${i}`,
            members: { create: { userId, role: "OWNER" } },
            workspaces: { create: { name: "Fixture", slug: "test" } },
          },
          include: { workspaces: true },
        });
        orgIds.push(org.id);
        const actor: Actor = {
          userId,
          orgId: org.id,
          workspaceId: org.workspaces[0].id,
          role: "OWNER",
          workspaceName: "Fixture",
        };
        if (i === 0) owner = actor;
        else other = actor;
      }
      await prisma.webSession.create({
        data: {
          tokenHash: tokenHash(token),
          userId,
          workspaceId: owner.workspaceId,
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      cookieJar.set(SESSION_COOKIE, token);
    });
    afterAll(async () => {
      cookieJar.clear();
      await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
      if (userId) await prisma.user.delete({ where: { id: userId } });
      await prisma.requestQuota.deleteMany({
        where: {
          OR: [
            { key: { startsWith: `login:${tokenHash(email)}:` } },
            ...(owner
              ? [{ key: { startsWith: `ai:${owner.workspaceId}:` } }]
              : []),
          ],
        },
      });
      await prisma.$disconnect();
    });
    it("binds session to active membership; rejects expiry and forged tokens", async () => {
      expect((await requireActor()).workspaceId).toBe(owner.workspaceId);
      cookieJar.set(SESSION_COOKIE, "forged");
      expect(await currentActor()).toBeNull();
      cookieJar.set(SESSION_COOKIE, token);
      await prisma.webSession.update({
        where: { tokenHash: tokenHash(token) },
        data: { expiresAt: new Date(0) },
      });
      expect(await currentActor()).toBeNull();
      await prisma.webSession.update({
        where: { tokenHash: tokenHash(token) },
        data: { expiresAt: new Date(Date.now() + 60_000) },
      });
      await prisma.membership.update({
        where: { orgId_userId: { orgId: owner.orgId, userId } },
        data: { status: "DISABLED" },
      });
      expect(await currentActor()).toBeNull();
      await prisma.membership.update({
        where: { orgId_userId: { orgId: owner.orgId, userId } },
        data: { status: "ACTIVE" },
      });
    });
    it("isolates list, reads, edits and approvals by workspace; restricts roles", async () => {
      const draft = await createDraft(owner, content);
      const foreign = await createDraft(other, content);
      await expect(getDraft(other, draft.id)).rejects.toMatchObject({
        status: 404,
      });
      await expect(
        changeDraft(other, draft.id, { action: "edit", content, version: 1 }),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        changeDraft(other, draft.id, { action: "approve", version: 1 }),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        createDraft({ ...owner, role: "VIEWER" }, content),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        changeDraft({ ...owner, role: "MEDIA_BUYER" }, draft.id, {
          action: "approve",
          version: 1,
        }),
      ).rejects.toMatchObject({ status: 403 });
      const response = await listDrafts();
      const data = await response.json();
      expect(data.drafts.map((x: { id: string }) => x.id)).toContain(draft.id);
      expect(data.drafts.map((x: { id: string }) => x.id)).not.toContain(
        foreign.id,
      );
    });
    it("gates experiment creation, snapshots approved content and resets approval on edit", async () => {
      const draft = await createDraft(owner, content);
      await expect(
        changeDraft(owner, draft.id, { action: "experiment", version: 1 }),
      ).rejects.toMatchObject({ status: 409 });
      await changeDraft(owner, draft.id, { action: "submit", version: 1 });
      await changeDraft(owner, draft.id, { action: "approve", version: 2 });
      const result = await changeDraft(owner, draft.id, {
        action: "experiment",
        version: 3,
      });
      const id = result.experimentId;
      if (!id) throw new Error("Experiment ID missing");
      await expect(getExperiment(other, id)).rejects.toMatchObject({
        status: 404,
      });
      await changeDraft(owner, draft.id, {
        action: "edit",
        version: 4,
        content: { ...content, clinic: "Edited clinic" },
      });
      expect((await getDraft(owner, draft.id)).status).toBe("DRAFT");
      expect((await getExperiment(owner, id)).snapshot).toEqual(content);
      const metrics: [Metrics, Metrics] = [
        { spend: 350, clicks: 1000, leads: 50 },
        { spend: 350, clicks: 1000, leads: 110 },
      ];
      await expect(
        updateExperiment(other, id, {
          metrics,
          elapsedDays: 7,
          version: 1,
          status: "RUNNING",
        }),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        updateExperiment({ ...owner, role: "VIEWER" }, id, {
          metrics,
          elapsedDays: 7,
          version: 1,
          status: "RUNNING",
        }),
      ).rejects.toMatchObject({ status: 403 });
      await updateExperiment(owner, id, {
        metrics,
        elapsedDays: 6,
        version: 1,
        status: "RUNNING",
      });
      await expect(
        updateExperiment(owner, id, {
          metrics,
          elapsedDays: 6,
          version: 2,
          status: "COMPLETED",
        }),
      ).rejects.toMatchObject({ status: 422 });
      await updateExperiment(owner, id, {
        metrics,
        elapsedDays: 7,
        version: 2,
        status: "COMPLETED",
      });
      await expect(
        updateExperiment(owner, id, {
          metrics,
          elapsedDays: 8,
          version: 3,
          status: "COMPLETED",
        }),
      ).rejects.toMatchObject({ status: 409 });
      expect(await prisma.auditLog.count({ where: { entityId: id } })).toBe(3);
    });
    it("recomputes policy on server and rejects stale concurrent writes", async () => {
      const unsafe = {
        ...content,
        variants: [
          { ...content.variants[0], text: "Guaranteed results" },
          content.variants[1],
        ],
      } as DraftContent;
      const bad = await createDraft(owner, unsafe);
      await expect(
        changeDraft(owner, bad.id, { action: "submit", version: 1 }),
      ).rejects.toMatchObject({ status: 422 });
      const draft = await createDraft(owner, content);
      const results = await Promise.allSettled([
        changeDraft(owner, draft.id, { action: "submit", version: 1 }),
        changeDraft(owner, draft.id, { action: "edit", content, version: 1 }),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(
        await prisma.auditLog.count({ where: { entityId: draft.id } }),
      ).toBe(2);
    });
    it("fails closed on absent AI configuration and does not log input content", async () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "");
      vi.stubEnv("LLM_MODEL", "");
      const brief = BriefSchema.parse(content);
      const result = await generate(
        new Request("http://localhost:3000/api/studio/generate", {
          method: "POST",
          headers: {
            origin: "http://localhost:3000",
            "content-type": "application/json",
          },
          body: JSON.stringify(brief),
        }),
      );
      expect(result.status).toBe(503);
      expect(
        await prisma.llmCallLog.count({
          where: { workspaceId: owner.workspaceId },
        }),
      ).toBe(0);
      vi.unstubAllEnvs();
    });
    it("validates AI role and logs successful/failed calls with real tokens and prompt versions, without raw content", async () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "test-placeholder");
      vi.stubEnv("LLM_MODEL", "test-model");
      const request = () =>
        new Request("http://localhost:3000/api/studio/generate", {
          method: "POST",
          headers: {
            origin: "http://localhost:3000",
            "content-type": "application/json",
          },
          body: JSON.stringify(BriefSchema.parse(content)),
        });
      const transport = vi.spyOn(globalThis, "fetch");
      try {
        await prisma.membership.update({
          where: { orgId_userId: { orgId: owner.orgId, userId } },
          data: { role: "VIEWER" },
        });
        expect((await generate(request())).status).toBe(403);
        expect(transport).not.toHaveBeenCalled();
        await prisma.membership.update({
          where: { orgId_userId: { orgId: owner.orgId, userId } },
          data: { role: "OWNER" },
        });
        let failCreative = false;
        transport.mockImplementation(async (_input, init) => {
          const req = JSON.parse(String(init?.body));
          if (String(req.system).includes("compliance reviewer")) return policyResponse("MEDIUM", "Üstünlük vurgusu.");
          if (failCreative) return new Response("sensitive upstream details", { status: 401 });
          return creativeResponse();
        });
        const ok = await generate(request());
        expect(ok.status).toBe(200);
        const generated = await ok.json();
        // Çıktı: CTA Meta türü, instantForm/whatsapp zorunlu, sunucu profili yok (klinik eşleşmedi), risk = max(kural LOW, LLM MEDIUM).
        expect(generated.content.variants[0].cta).toBe("LEARN_MORE");
        expect(generated.content.instantForm.questions).toHaveLength(2);
        expect(generated.content.whatsapp.welcome).toContain("otomatik");
        expect(generated.content.profile).toBeUndefined();
        expect(generated.policy).toMatchObject({ risk: "MEDIUM", ruleRisk: "LOW", llm: { risk: "MEDIUM", reason: "Üstünlük vurgusu." } });
        failCreative = true;
        const failed = await generate(request());
        expect(failed.status).toBe(502);
        expect(await failed.text()).not.toContain("sensitive upstream details");
        const logs = await prisma.llmCallLog.findMany({
          where: { workspaceId: owner.workspaceId },
          orderBy: { createdAt: "asc" },
        });
        expect(logs.map((l) => `${l.agent}:${l.promptVersion}:${l.status}`)).toEqual([
          "creative-writer:creative-v1:COMPLETED",
          "policy-checker:policy-risk-v1:COMPLETED",
          "creative-writer:creative-v1:FAILED",
        ]);
        expect(logs[0].inputTokens).toBe(20);
        expect(logs[0].outputTokens).toBe(30);
        expect(logs[1].inputTokens).toBe(3);
        expect(logs[0].model).toBe("test-model");
        expect(JSON.stringify(logs)).not.toContain(content.clinic);
      } finally {
        await prisma.membership.update({
          where: { orgId_userId: { orgId: owner.orgId, userId } },
          data: { role: "OWNER" },
        });
        transport.mockRestore();
        vi.unstubAllEnvs();
      }
    });
    it("merges rule and LLM policy layers: max risk, {error:true} on LLM failure, null without a key", async () => {
      const policyAt = (id: string) => prisma.studioDraft.findUniqueOrThrow({ where: { id } }).then((d) => d.policy as { risk: string; ruleRisk: string; llm: unknown });
      // Anahtar yok → llm:null, karar kural sonucu.
      vi.stubEnv("ANTHROPIC_API_KEY", "");
      vi.stubEnv("LLM_MODEL", "");
      const plain = await createDraft(owner, content);
      expect(await policyAt(plain.id)).toMatchObject({ risk: "LOW", ruleRisk: "LOW", llm: null });
      vi.stubEnv("ANTHROPIC_API_KEY", "test-placeholder");
      vi.stubEnv("LLM_MODEL", "test-model");
      const transport = vi.spyOn(globalThis, "fetch");
      try {
        transport.mockResolvedValueOnce(policyResponse("HIGH", "Kesin sonuç vaadi."));
        const high = await createDraft(owner, content);
        expect(await policyAt(high.id)).toMatchObject({ risk: "HIGH", ruleRisk: "LOW", llm: { risk: "HIGH" } });
        // LLM yüksek risk dediyse onaya gönderilemez.
        transport.mockResolvedValueOnce(policyResponse("HIGH", "Kesin sonuç vaadi."));
        await expect(changeDraft(owner, high.id, { action: "submit", version: 1 })).rejects.toMatchObject({ status: 422 });
        // LLM hatası → llm:{error:true}, risk kural sonucu; FAILED günlüğü.
        transport.mockResolvedValueOnce(new Response("boom", { status: 500 }));
        const errored = await createDraft(owner, content);
        expect(await policyAt(errored.id)).toMatchObject({ risk: "LOW", ruleRisk: "LOW", llm: { error: true } });
        const failedLogs = await prisma.llmCallLog.count({ where: { workspaceId: owner.workspaceId, agent: "policy-checker", status: "FAILED" } });
        expect(failedLogs).toBeGreaterThanOrEqual(1);
        // Kural HIGH + LLM LOW → HIGH (max).
        transport.mockResolvedValueOnce(policyResponse("LOW", "Nötr."));
        const unsafe = { ...content, variants: [{ ...content.variants[0], text: "Guaranteed results" }, content.variants[1]] } as DraftContent;
        const ruleHigh = await createDraft(owner, unsafe);
        expect(await policyAt(ruleHigh.id)).toMatchObject({ risk: "HIGH", ruleRisk: "HIGH", llm: { risk: "LOW" } });
        // Reject LLM çağırmaz: onaya gönderilmiş taslak reddedilirken fetch çağrılmaz.
        transport.mockResolvedValueOnce(policyResponse("LOW", "Nötr."));
        await changeDraft(owner, plain.id, { action: "submit", version: 1 });
        const calls = transport.mock.calls.length;
        await changeDraft(owner, plain.id, { action: "reject", version: 2 });
        expect(transport.mock.calls.length).toBe(calls);
        expect((await getDraft(owner, plain.id)).status).toBe("REJECTED");
      } finally {
        transport.mockRestore();
        vi.unstubAllEnvs();
      }
    });
    it("requires an acknowledged warning to submit MEDIUM risk and records it in the audit log", async () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "");
      vi.stubEnv("LLM_MODEL", "");
      // Kural katmanı MEDIUM: klinik yasaklı ifadesi.
      const clinic = await prisma.clinicProfile.create({
        data: { workspaceId: owner.workspaceId, name: "Fixture clinic", slug: `fx-${suffix}`, brandBannedPhrases: ["en ucuz"], languages: ["EN"] },
      });
      try {
        const medium = { ...content, whatsapp: { welcome: "Merhaba! Ben otomatik asistanım, en ucuz paketi anlatayım." } } as DraftContent;
        const draft = await createDraft(owner, medium);
        const stored = (await getDraft(owner, draft.id)).policy as { risk: string; findings: { rule: string }[] };
        // WhatsApp karşılaması da kontrol edilen metne dahildir.
        expect(stored.risk).toBe("MEDIUM");
        expect(stored.findings.map((f) => f.rule)).toContain("clinic-restriction");
        await expect(changeDraft(owner, draft.id, { action: "submit", version: 1 })).rejects.toMatchObject({ status: 422 });
        // Route: 422 gövdesinde policyWarning döner.
        const blocked = await patchDraft(
          new Request(`http://localhost:3000/api/studio/${draft.id}`, {
            method: "PATCH",
            headers: { origin: "http://localhost:3000", "content-type": "application/json" },
            body: JSON.stringify({ action: "submit", version: 1 }),
          }),
          { params: Promise.resolve({ id: draft.id }) },
        );
        expect(blocked.status).toBe(422);
        const warning = await blocked.json();
        expect(warning.policyWarning).toMatchObject({ risk: "MEDIUM", ruleRisk: "MEDIUM", llm: null });
        expect((await getDraft(owner, draft.id)).status).toBe("DRAFT");
        await changeDraft(owner, draft.id, { action: "submit", version: 1, acknowledgeWarning: true });
        expect((await getDraft(owner, draft.id)).status).toBe("IN_REVIEW");
        const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: draft.id, action: "DRAFT_SUBMIT" } });
        expect(audit.after).toMatchObject({ policyWarningAcknowledged: true, risk: "MEDIUM" });
        // Profil zenginleştirme: istemci profili atılır, DB profili kullanılır.
        const enriched = await enrichBriefWithProfile(
          { ...BriefSchema.parse(content), clinic: "Fixture clinic", profile: { bannedPhrases: ["istemci"] } },
          owner.workspaceId,
        );
        expect(enriched.profile).toMatchObject({ bannedPhrases: ["en ucuz"], languages: ["EN"] });
        const unmatched = await enrichBriefWithProfile(
          { ...BriefSchema.parse(content), clinic: "Bilinmeyen", profile: { bannedPhrases: ["istemci"] } },
          other.workspaceId,
        );
        expect(unmatched.profile).toBeUndefined();
      } finally {
        await prisma.clinicProfile.delete({ where: { id: clinic.id } });
        vi.unstubAllEnvs();
      }
    });
    it("logs in with credentials, rotates session and revokes on logout", async () => {
      const req = (data: object) =>
        new Request("http://localhost:3000/api/session", {
          method: "POST",
          headers: {
            origin: "http://localhost:3000",
            "content-type": "application/json",
          },
          body: JSON.stringify(data),
        });
      expect(
        (
          await login(
            req({ email, password: "incorrect", workspace: owner.workspaceId }),
          )
        ).status,
      ).toBe(401);
      expect(
        (await login(req({ email, password, workspace: owner.workspaceId })))
          .status,
      ).toBe(200);
      expect(
        await prisma.webSession.findUnique({
          where: { tokenHash: tokenHash(token) },
        }),
      ).toBeNull();
      expect((await requireActor()).workspaceId).toBe(owner.workspaceId);
      expect(
        await logout(
          new Request("http://localhost:3000/api/session", {
            method: "DELETE",
            headers: { origin: "http://localhost:3000" },
          }),
        ),
      ).toHaveProperty("status", 200);
      expect(await currentActor()).toBeNull();
    });
  },
);

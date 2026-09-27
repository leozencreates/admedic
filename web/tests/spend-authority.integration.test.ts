import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { prisma, type MembershipStatus, type Role } from "@admedic/database";
import { tokenHash } from "../app/_lib/password";
import { SESSION_COOKIE } from "../app/_lib/auth";

const { cookieJar } = vi.hoisted(() => ({ cookieJar: new Map<string, string>() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (key: string) => (cookieJar.has(key) ? { value: cookieJar.get(key) } : undefined),
    set: (key: string, value: string) => cookieJar.set(key, value),
    delete: (key: string) => cookieJar.delete(key),
  }),
}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

import { GET as listMembers } from "../app/api/org/members/route";
import { PUT as putSpendAuthority } from "../app/api/org/members/[userId]/spend-authority/route";
import { GET as sessionGet } from "../app/api/session/route";
import { hasSpendAuthority } from "../app/_lib/spend-authority";

type Fixture = { key: string; role: Role; status?: MembershipStatus; foreign?: boolean };
const FIXTURES: Fixture[] = [
  { key: "OWNER", role: "OWNER" },
  { key: "ADMIN", role: "ADMIN" },
  { key: "MEDIA_BUYER", role: "MEDIA_BUYER" },
  { key: "VIEWER", role: "VIEWER" },
  { key: "DISABLED_ADMIN", role: "ADMIN", status: "DISABLED" },
  { key: "FOREIGN", role: "OWNER", foreign: true },
];

describe.skipIf(process.env.STUDIO_DB_TEST !== "1")("spend authority delegation (spec 3.6)", () => {
  const suffix = randomBytes(8).toString("hex");
  const orgIds: string[] = [];
  const userIds: Record<string, string> = {};
  const tokens: Record<string, string> = {};
  let orgId = "";

  beforeAll(async () => {
    const orgs = await Promise.all(
      [false, true].map((foreign) =>
        prisma.organization.create({
          data: { name: "Spend fixture", slug: `spend-${suffix}-${foreign}`, workspaces: { create: { name: "Ws", slug: "ws" } } },
          include: { workspaces: true },
        }),
      ),
    );
    orgIds.push(...orgs.map((o) => o.id));
    orgId = orgs[0]!.id;
    for (const f of FIXTURES) {
      const org = orgs[f.foreign ? 1 : 0]!;
      const user = await prisma.user.create({ data: { email: `${suffix}-${f.key.toLowerCase()}@example.invalid`, name: f.key } });
      userIds[f.key] = user.id;
      await prisma.membership.create({ data: { orgId: org.id, userId: user.id, role: f.role, status: f.status ?? "ACTIVE" } });
      if ((f.status ?? "ACTIVE") !== "ACTIVE") continue;
      const token = randomBytes(32).toString("hex");
      await prisma.webSession.create({
        data: { tokenHash: tokenHash(token), userId: user.id, workspaceId: org.workspaces[0]!.id, expiresAt: new Date(Date.now() + 600_000) },
      });
      tokens[f.key] = token;
    }
  });

  afterAll(async () => {
    cookieJar.clear();
    await prisma.auditLog.deleteMany({ where: { orgId: { in: orgIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
    await prisma.user.deleteMany({ where: { id: { in: Object.values(userIds) } } });
    await prisma.$disconnect();
  });

  const as = (key: string) => cookieJar.set(SESSION_COOKIE, tokens[key]!);
  const put = (target: string, body: unknown, origin = "http://localhost:3000") =>
    putSpendAuthority(
      new Request(`http://localhost:3000/api/org/members/${target}/spend-authority`, {
        method: "PUT",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ userId: target }) },
    );
  const sessionCanApprove = async (key: string) => {
    as(key);
    return ((await (await sessionGet()).json()) as { actor: { canApproveSpend: boolean } }).actor.canApproveSpend;
  };

  it("lists members with effective authority for OWNER/ADMIN only", async () => {
    for (const key of ["VIEWER", "MEDIA_BUYER"]) {
      as(key);
      expect((await listMembers()).status).toBe(403);
    }
    as("ADMIN");
    const admin = (await (await listMembers()).json()) as { canManageSpendAuthority: boolean; members: { email: string }[] };
    expect(admin.canManageSpendAuthority).toBe(false);
    as("OWNER");
    const owner = (await (await listMembers()).json()) as {
      canManageSpendAuthority: boolean;
      members: { userId: string; role: string; canApproveSpend: boolean; delegable: boolean; isSelf: boolean }[];
    };
    expect(owner.canManageSpendAuthority).toBe(true);
    expect(owner.members).toHaveLength(5);
    const byUser = new Map(owner.members.map((m) => [m.userId, m]));
    expect(byUser.get(userIds.OWNER!)).toMatchObject({ canApproveSpend: true, delegable: false, isSelf: true });
    expect(byUser.get(userIds.ADMIN!)).toMatchObject({ canApproveSpend: false, delegable: true });
    expect(byUser.get(userIds.VIEWER!)).toMatchObject({ canApproveSpend: false, delegable: false });
    expect(byUser.get(userIds.DISABLED_ADMIN!)).toMatchObject({ canApproveSpend: false, delegable: false });
    expect(await sessionCanApprove("OWNER")).toBe(true);
    expect(await sessionCanApprove("ADMIN")).toBe(false);
  });

  it("only the Owner grants or revokes, only to active ADMIN/MEDIA_BUYER members of the same organization", async () => {
    as("ADMIN");
    expect((await put(userIds.MEDIA_BUYER!, { granted: true })).status).toBe(403);
    as("OWNER");
    expect((await put(userIds.ADMIN!, { granted: true }, "https://other.invalid")).status).toBe(403);
    expect((await put(userIds.ADMIN!, { granted: "yes" })).status).toBe(400);
    expect((await put(userIds.VIEWER!, { granted: true })).status).toBe(422);
    expect((await put(userIds.DISABLED_ADMIN!, { granted: true })).status).toBe(409);
    expect((await put(userIds.OWNER!, { granted: false })).status).toBe(409);
    expect((await put(userIds.FOREIGN!, { granted: true })).status).toBe(404);

    const granted = await put(userIds.ADMIN!, { granted: true });
    expect(granted.status).toBe(200);
    expect(((await granted.json()) as { member: { canApproveSpend: boolean; changed: boolean } }).member).toMatchObject({ canApproveSpend: true, changed: true });
    const again = await put(userIds.ADMIN!, { granted: true });
    expect(((await again.json()) as { member: { changed: boolean } }).member.changed).toBe(false);
    const row = await prisma.membership.findUniqueOrThrow({ where: { orgId_userId: { orgId, userId: userIds.ADMIN! } } });
    expect(row).toMatchObject({ canApproveSpend: true, spendGrantedBy: userIds.OWNER });
    expect(row.spendGrantedAt).not.toBeNull();
    expect(await sessionCanApprove("ADMIN")).toBe(true);

    as("OWNER");
    expect((await put(userIds.ADMIN!, { granted: false })).status).toBe(200);
    expect(await sessionCanApprove("ADMIN")).toBe(false);
    const audits = await prisma.auditLog.findMany({ where: { orgId, entityType: "MEMBERSHIP" }, orderBy: { createdAt: "asc" } });
    expect(audits.map((a) => a.action)).toEqual(["SPEND_AUTHORITY_GRANTED", "SPEND_AUTHORITY_REVOKED"]);
    expect(audits[0]!.before).toMatchObject({ canApproveSpend: false });
    expect(audits[0]!.after).toMatchObject({ canApproveSpend: true, spendGrantedBy: userIds.OWNER });
    expect(audits[1]!.after).toMatchObject({ canApproveSpend: false, spendGrantedBy: null });
  });

  it("a granted flag never outlives a role change to a non-delegable role", async () => {
    await prisma.membership.update({
      where: { orgId_userId: { orgId, userId: userIds.MEDIA_BUYER! } },
      data: { canApproveSpend: true, role: "ANALYST" },
    });
    expect(await hasSpendAuthority({ orgId, userId: userIds.MEDIA_BUYER! })).toBe(false);
    await prisma.membership.update({ where: { orgId_userId: { orgId, userId: userIds.MEDIA_BUYER! } }, data: { role: "MEDIA_BUYER" } });
    expect(await hasSpendAuthority({ orgId, userId: userIds.MEDIA_BUYER! })).toBe(true);
    await prisma.membership.update({ where: { orgId_userId: { orgId, userId: userIds.MEDIA_BUYER! } }, data: { canApproveSpend: false } });
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "./index";
import {
  assertWorkspaceAccess,
  defaultWorkspaceFor,
  getRole,
  listOrgsForUser,
  requireMembership,
  requireRole,
} from "./tenant";
import type { Role } from "@prisma/client";

const RUN = Date.now().toString(36);

let orgId = "";
let workspaceId = "";
let ownerId = "";
let viewerId = "";
let outsiderId = "";

beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: `Test Org ${RUN}`, slug: `test-${RUN}` },
  });
  orgId = org.id;

  const workspace = await prisma.workspace.create({
    data: {
      orgId,
      name: "Test Workspace",
      slug: `ws-${RUN}`,
      currency: "EUR",
      agentStatus: "PAUSED",
    },
  });
  workspaceId = workspace.id;

  const owner = await prisma.user.create({ data: { email: `owner-${RUN}@test.dev`, name: "Owner" } });
  const viewer = await prisma.user.create({ data: { email: `viewer-${RUN}@test.dev`, name: "Viewer" } });
  const outsider = await prisma.user.create({ data: { email: `out-${RUN}@test.dev`, name: "Outsider" } });
  ownerId = owner.id;
  viewerId = viewer.id;
  outsiderId = outsider.id;

  await prisma.membership.create({ data: { orgId, userId: ownerId, role: "OWNER", status: "ACTIVE" } });
  await prisma.membership.create({ data: { orgId, userId: viewerId, role: "VIEWER", status: "ACTIVE" } });
  await prisma.membership.create({ data: { orgId, userId: outsiderId, role: "VIEWER", status: "PENDING" } });
});

afterAll(async () => {
  await prisma.workspace.deleteMany({ where: { orgId } });
  await prisma.membership.deleteMany({ where: { orgId } });
  await prisma.organization.deleteMany({ where: { id: orgId } });
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, viewerId, outsiderId] } } });
});

describe("tenant helpers", () => {
  it("requireMembership: aktif üye geçer, üye olmayan PERMISSION_ERROR atar", async () => {
    const m = await requireMembership(ownerId, orgId);
    expect(m.role).toBe("OWNER");

    await expect(requireMembership(outsiderId, orgId)).rejects.toThrow("erişiminiz yok");
    await expect(requireMembership("no-such-user", orgId)).rejects.toThrow("erişiminiz yok");
  });

  it("requireRole: OWNER ≥ VIEWER geçer; VIEWER ≥ OWNER bloklanır", async () => {
    await expect(requireRole(ownerId, orgId, "VIEWER" as Role)).resolves.toBeTruthy();
    await expect(requireRole(ownerId, orgId, "OWNER" as Role)).resolves.toBeTruthy();
    await expect(requireRole(viewerId, orgId, "OWNER" as Role)).rejects.toThrow("en az OWNER");
    await expect(requireRole(viewerId, orgId, "ADMIN" as Role)).rejects.toThrow();
  });

  it("getRole: aktif üye rolünü döner, pending üye undefined", async () => {
    expect(await getRole(ownerId, orgId)).toBe("OWNER");
    expect(await getRole(viewerId, orgId)).toBe("VIEWER");
    expect(await getRole(outsiderId, orgId)).toBeUndefined();
  });

  it("listOrgsForUser: yalnızca ACTIVE üyelikler döner", async () => {
    const orgs = await listOrgsForUser(ownerId);
    expect(orgs.some((o) => o.id === orgId && o.role === "OWNER")).toBe(true);
    const outsiderOrgs = await listOrgsForUser(outsiderId);
    expect(outsiderOrgs.some((o) => o.id === orgId)).toBe(false);
  });

  it("assertWorkspaceAccess: erişim yoksa PERMISSION_ERROR, başarılıysa orgId döner", async () => {
    await expect(assertWorkspaceAccess(ownerId, workspaceId)).resolves.toEqual({ orgId, workspaceId });
    await expect(assertWorkspaceAccess(outsiderId, workspaceId)).rejects.toThrow("erişiminiz yok");
    await expect(assertWorkspaceAccess(ownerId, "no-such-ws")).rejects.toThrow("bulunamadı");
  });

  it("defaultWorkspaceFor: kullanıcının ilk workspace'ini döner", async () => {
    const ws = await defaultWorkspaceFor(ownerId);
    expect(ws?.id).toBe(workspaceId);
    const outsiderWs = await defaultWorkspaceFor(outsiderId);
    expect(outsiderWs).toBeUndefined();
  });
});
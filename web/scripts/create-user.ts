import { prisma } from "@admedic/database";
import { loadEnv } from "@admedic/config";
import { z } from "zod";
import { hashPassword } from "../app/_lib/password";

async function main() {
  loadEnv();
  const input = z
    .object({
      BOOTSTRAP_EMAIL: z
        .string()
        .email()
        .transform((s) => s.toLowerCase()),
      BOOTSTRAP_PASSWORD: z.string().min(12).max(256),
      BOOTSTRAP_CLINIC: z.string().trim().min(1).max(100),
    })
    .safeParse(process.env);
  if (!input.success)
    throw new Error(
      "BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD (en az 12 karakter) ve BOOTSTRAP_CLINIC ayarlayın.",
    );
  const {
    BOOTSTRAP_EMAIL: email,
    BOOTSTRAP_PASSWORD: password,
    BOOTSTRAP_CLINIC: name,
  } = input.data;
  const passwordHash = await hashPassword(password);
  const workspace = await prisma.$transaction(async (tx) => {
    // Never overwrite an existing user's password or memberships.
    const user = await tx.user.create({ data: { email, passwordHash } });
    const org = await tx.organization.create({
      data: {
        name,
        slug: `clinic-${user.id}`,
        members: { create: { userId: user.id, role: "OWNER" } },
      },
    });
    const ws = await tx.workspace.create({
      data: { orgId: org.id, name, slug: "main" },
    });
    await tx.auditLog.create({
      data: {
        orgId: org.id,
        workspaceId: ws.id,
        userId: user.id,
        action: "WORKSPACE_CREATED",
        entityType: "WORKSPACE",
        entityId: ws.id,
      },
    });
    return ws;
  });
  console.log(
    `Kullanıcı oluşturuldu. Giriş için çalışma alanı ID: ${workspace.id}`,
  );
}
main()
  .catch(() => {
    console.error(
      "Kullanıcı oluşturulamadı. Ortam ayarlarını, veritabanını ve e-postanın benzersiz olduğunu kontrol edin.",
    );
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

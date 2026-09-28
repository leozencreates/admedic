import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { prisma } from "@admedic/database";
import { hashPassword, tokenHash } from "../app/_lib/password";

test.describe("authenticated studio", () => {
  test.skip(
    process.env.STUDIO_E2E !== "1",
    "Opt-in database fixtures: STUDIO_E2E=1",
  );
  const suffix = randomBytes(8).toString("hex");
  const email = `browser-${suffix}@example.invalid`;
  const password = randomBytes(24).toString("hex");
  let orgId: string;
  let userId: string;
  let workspaceId: string;
  test.beforeAll(async () => {
    const user = await prisma.user.create({
      data: { email, passwordHash: await hashPassword(password) },
    });
    userId = user.id;
    const org = await prisma.organization.create({
      data: {
        name: "Browser fixture",
        slug: `browser-${suffix}`,
        members: { create: { userId, role: "OWNER" } },
        workspaces: { create: { name: "Browser fixture", slug: "main" } },
      },
      include: { workspaces: true },
    });
    orgId = org.id;
    workspaceId = org.workspaces[0].id;
  });
  test.afterAll(async () => {
    if (orgId) await prisma.organization.delete({ where: { id: orgId } });
    if (userId) await prisma.user.delete({ where: { id: userId } });
    await prisma.requestQuota.deleteMany({
      where: { key: { startsWith: `login:${tokenHash(email)}:` } },
    });
    await prisma.$disconnect();
  });
  test("login → draft → policy → approval → experiment → persisted metrics; mobile RTL", async ({
    page,
  }) => {
    await page.goto("/studio");
    await expect(page).toHaveURL(/\/login/);
    await page.getByLabel("E-posta", { exact: true }).fill(email);
    await page.getByLabel("Parola", { exact: true }).fill(password);
    await page.getByLabel("Çalışma alanı ID").fill(workspaceId);
    await page.getByRole("button", { name: "Çalışma alanına gir" }).click();
    // Giriş, `next` parametresiyle istenen sayfaya (/studio) geri döner.
    await expect(page).toHaveURL((url) => url.pathname === "/studio");
    await page.getByLabel("Klinik adı", { exact: true }).fill("Browser clinic");
    await page.getByLabel("Hizmet / işlem").fill("Dental services");
    await page.getByLabel("Hedef pazar").fill("UAE");
    await page.getByLabel("Reklam dili").selectOption("AR");
    await page
      .getByRole("button", { name: "Boş taslakla başla" })
      .click();
    const articles = page.locator("article.ad-preview");
    for (let i = 0; i < 2; i++) {
      await articles
        .nth(i)
        .getByRole("textbox", { name: "Başlık", exact: true })
        .fill(i ? "تعرف على خدماتنا" : "تعرف على فريقنا");
      await articles
        .nth(i)
        .getByRole("textbox", { name: "Reklam metni" })
        .fill("تواصل مع فريقنا لمعرفة المزيد عن الخدمات.");
      await articles
        .nth(i)
        .getByRole("combobox", { name: "Eylem düğmesi" })
        .selectOption("LEARN_MORE");
    }
    await expect(
      articles.first().getByRole("textbox", { name: "Başlık", exact: true }),
    ).toHaveAttribute("dir", "rtl");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole("button", { name: "Kaydet", exact: true }).click();
    await expect(page).toHaveURL(/\/studio\?id=/);
    await page
      .getByRole("button", { name: "Onaya gönder", exact: true })
      .click();
    await page
      .getByRole("button", { name: "İçeriği onayla", exact: true })
      .click();
    await page.getByRole("button", { name: "A/B deneyi oluştur" }).click();
    await expect(page).toHaveURL(/\/tests\//);
    await page.getByRole("button", { name: "Veri takibini başlat" }).click();
    await expect(
      page.getByRole("button", { name: "Deneyi tamamla" }),
    ).toBeVisible();
    await page.getByLabel("Geçen süre (gün)").fill("7");
    for (let i = 0; i < 2; i++) {
      // Etiket hesabın para birimini gösterir; fikstürde reklam hesabı yok → EUR.
      await page.getByLabel("Harcama (EUR)").nth(i).fill("350");
      await page.getByLabel("Tıklama", { exact: true }).nth(i).fill("1000");
      await page
        .getByLabel("Lead", { exact: true })
        .nth(i)
        .fill(i ? "110" : "50");
    }
    await page.getByRole("button", { name: "Metrikleri kaydet" }).click();
    await expect(
      page.getByText("Deney kaydedildi.", { exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("Lead", { exact: true }).nth(1)).toHaveValue(
      "110",
    );
    await expect(
      page.getByRole("heading", { name: "B varyantı öne çıkıyor" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Deneyi tamamla" }).click();
    await expect(
      page.getByLabel("Lead", { exact: true }).first(),
    ).toBeDisabled();
    await page.getByRole("button", { name: "Oturumu kapat" }).click();
    await expect(page).toHaveURL(/\/login/);
  });
});

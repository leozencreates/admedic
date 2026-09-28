import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.pw.ts",
  workers: 1,
  timeout: 60_000,
  use: {
    baseURL: "http://localhost:3000",
    headless: true,
    screenshot: "only-on-failure",
    // İsteğe bağlı: önceden kurulmuş bir Chromium (ör. CI imajı). Verilmezse Playwright'ın kendi tarayıcısı kullanılır.
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:3000/login",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});

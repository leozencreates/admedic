import { existsSync } from "fs";
import { dirname, join } from "path";
import { config as loadDotenv } from "dotenv";
import { defineConfig } from "prisma/config";

// Monorepo köki `.env` dosyasını yükle (cwd'den yukarı çıkarak).
let dir = process.cwd();
for (let i = 0; i < 10; i++) {
  const file = join(dir, ".env");
  if (existsSync(file)) {
    loadDotenv({ path: file, quiet: true });
    break;
  }
  const parent = dirname(dir);
  if (parent === dir) break;
  dir = parent;
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
});
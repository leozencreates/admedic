# syntax=docker/dockerfile:1.7
# Admedic sunucu imajları (ADR-0023). Hedefler:
#   web    — Next.js paneli (standalone çıktı; yalnızca gereken dosyalar)
#   worker — meta-sync arka plan işçisi (insights, anomali, asistan, saklama süresi)
#   tools  — veritabanı göçü ve yönetim komutları (prisma migrate deploy, ilk kullanıcı)
# Derleme: docker compose -f deploy/docker-compose.prod.yml build

FROM node:22-bookworm-slim AS base
ENV NEXT_TELEMETRY_DISABLED=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CHECKPOINT_DISABLE=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates openssl \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable \
 && corepack prepare pnpm@11.20.0 --activate
WORKDIR /app

# ---- bağımlılıklar + derleme ---------------------------------------------------------------------------------
FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
# Rust'sız Prisma istemcisi (sorgu motoru ikili dosyası yok); paketler dist/'e, panel .next/standalone'a derlenir.
RUN pnpm db:generate \
 && pnpm exec turbo run build --filter=@admedic/web... --filter=@admedic/meta-sync... --env-mode=loose

# ---- yönetim komutları (göç, ilk kullanıcı) -------------------------------------------------------------------
FROM build AS tools
ENV NODE_ENV=production
WORKDIR /app/packages/database
CMD ["./node_modules/.bin/prisma", "migrate", "deploy"]

# ---- arka plan işçisi -----------------------------------------------------------------------------------------
FROM build AS worker
ENV NODE_ENV=production
WORKDIR /app/workers/meta-sync
USER node
CMD ["./node_modules/.bin/tsx", "src/cli.ts"]

# ---- panel ----------------------------------------------------------------------------------------------------
FROM base AS web
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/web/.next/standalone ./
COPY --from=build --chown=node:node /app/web/.next/static ./web/.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"
CMD ["node", "web/server.js"]

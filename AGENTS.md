<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

<!-- BEGIN:admedic-project-spec -->
# Proje Spesifikasyonu (Zorunlu Bağlam)

Bu repo, "Admedic" (çalışma adı) AI Sağlık Turizmi Meta Reklam Ajanı projesidir.

- **Ana bağlam dosyası: `docs/spec.md`.** Her görevden önce ilgili bölümü oku.
- Uygulama adı kodda **sabit yazılmaz**; `APP_NAME` ortam değişkeninden okunur.
- Bir faza başlamadan önce görev listesi + plan çıkar ve kullanıcıdan onay bekle.
- Meta API davranışı hakkında emin değilsen tahmin yazma; güncel resmi dokümantasyona bak, bulguları `docs/meta-constraints.md` altına tarihle not et.
- Mimari kararlar için `docs/decisions/` altına ADR yaz.
<!-- END:admedic-project-spec -->

#!/usr/bin/env bash
# Admedic veritabanı yedeği (ADR-0023): günlük pg_dump, 14 gün saklama.
# Kullanım (sunucuda, deploy/ klasöründe): ./backup.sh        — cron: 30 3 * * * cd /opt/admedic/deploy && ./backup.sh
# Yedekler şifreli kişisel veri alanları içerir; ENCRYPTION_KEY yedekten AYRI saklanmalı. Yedeği sunucu dışına da
# kopyalayın (aynı sunucudaki yedek, sunucu kaybında işe yaramaz); hedef Türkiye'de olmalı (KVKK).
set -euo pipefail
cd "$(dirname "$0")"
KEEP_DAYS="${KEEP_DAYS:-14}"
mkdir -p backups
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
file="backups/admedic-${stamp}.dump"
docker compose -f docker-compose.prod.yml exec -T postgres \
  sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner' > "${file}.part"
mv "${file}.part" "$file"
chmod 600 "$file"
find backups -name 'admedic-*.dump' -mtime "+${KEEP_DAYS}" -delete
echo "Yedek alındı: $file ($(du -h "$file" | cut -f1))"

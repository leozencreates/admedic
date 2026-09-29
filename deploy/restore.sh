#!/usr/bin/env bash
# Yedekten geri dönüş (ADR-0023). Mevcut veritabanının ÜZERİNE yazar; önce web ve işçiyi durdurur.
# Kullanım: ./restore.sh backups/admedic-20261001T033000Z.dump
set -euo pipefail
cd "$(dirname "$0")"
file="${1:?Kullanım: ./restore.sh <yedek dosyası>}"
[ -f "$file" ] || { echo "Dosya yok: $file" >&2; exit 1; }
read -r -p "Veritabanının üzerine '$file' yazılacak. Devam için EVET yazın: " answer
[ "$answer" = "EVET" ] || { echo "Vazgeçildi."; exit 1; }
docker compose -f docker-compose.prod.yml stop web worker
docker compose -f docker-compose.prod.yml exec -T postgres \
  sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner' < "$file"
docker compose -f docker-compose.prod.yml up -d web worker
echo "Geri yüklendi: $file"

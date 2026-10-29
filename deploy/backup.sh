#!/usr/bin/env bash
# M2-OPS-01 数据库定时备份：pg_dump 自定义格式（-Fc，压缩），保留最近 N 份（默认 14）。
# 用法：./backup.sh [保留份数]
# 定时（crontab -e，每天 04:00 备份并记日志）：
#   0 4 * * * cd /srv/mini-video/deploy && ./backup.sh >> backups/backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")"

KEEP="${1:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p backups
OUT="backups/miv-${STAMP}.dump"

docker compose exec -T postgres pg_dump -U "${POSTGRES_USER:-miv}" -d "${POSTGRES_DB:-miv}" -Fc > "$OUT"
SIZE="$(du -h "$OUT" | cut -f1)"
echo "$(date '+%F %T') 已备份 ${OUT}（${SIZE}）"

# 只保留最近 KEEP 份
ls -1t backups/miv-*.dump 2>/dev/null | tail -n "+$((KEEP + 1))" | while read -r old; do
  rm -f "$old"
  echo "$(date '+%F %T') 已清理过期备份 ${old}"
done

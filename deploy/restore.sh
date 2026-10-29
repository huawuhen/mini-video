#!/usr/bin/env bash
# M2-OPS-01 数据库恢复：从 backup.sh 产生的 .dump 恢复。
# 用法：
#   ./restore.sh backups/miv-xxxx.dump             # 原库覆盖恢复（--clean --if-exists，保留库与角色）
#   ./restore.sh backups/miv-xxxx.dump --recreate  # 危险：先 DROP DATABASE 再整库重建（彻底恢复到备份时刻）
# 恢复后必须重启 api/worker（清掉进程内缓存与渠道驱动实例）：
#   docker compose restart api worker
set -euo pipefail
cd "$(dirname "$0")"

FILE="${1:?用法: ./restore.sh backups/miv-xxxx.dump [--recreate]}"
MODE="${2:-}"
[ -f "$FILE" ] || { echo "备份文件不存在：$FILE" >&2; exit 1; }

PSQL="docker compose exec -T postgres psql -U ${POSTGRES_USER:-miv} -d postgres"
if [ "$MODE" = "--recreate" ]; then
  echo ">> 整库重建（将清空现有数据）…"
  $PSQL -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${POSTGRES_DB:-miv}' AND pid <> pg_backend_pid();" >/dev/null
  $PSQL -c "DROP DATABASE IF EXISTS ${POSTGRES_DB:-miv};"
  $PSQL -c "CREATE DATABASE ${POSTGRES_DB:-miv} OWNER ${POSTGRES_USER:-miv};"
  cat "$FILE" | docker compose exec -T postgres pg_restore -U "${POSTGRES_USER:-miv}" -d "${POSTGRES_DB:-miv}" --no-owner
else
  echo ">> 覆盖恢复（保留库，清表重建）…"
  cat "$FILE" | docker compose exec -T postgres pg_restore -U "${POSTGRES_USER:-miv}" -d "${POSTGRES_DB:-miv}" --clean --if-exists --no-owner
fi

echo ">> 恢复完成。核对数据并重启服务：docker compose restart api worker"

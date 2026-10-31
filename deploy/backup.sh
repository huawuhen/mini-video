#!/usr/bin/env bash
# M2-OPS-01 数据库定时备份：pg_dump 自定格式（-Fc，压缩），保留最近 N 份（默认 14）。
# 用法：./backup.sh [--upload] [保留份数]
#   --upload  备份后把 dump 推到七牛私有桶的独立前缀 backups/db/（异地副本，
#             凭证用 deploy/.env 的 QINIU_*，经 api 容器内 node 计算上传凭证）
# 定时（crontab -e，每天 04:00 备份 + 异地副本并记日志）：
#   0 4 * * * cd /srv/mini-video/deploy && ./backup.sh --upload >> backups/backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")"

# 从 .env 安全读单个变量（不 source：密钥值可能含 shell 特殊字符）
get_env() { grep -E "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2-; }

UPLOAD=0
KEEP=14
for arg in "$@"; do
  if [ "$arg" = "--upload" ]; then UPLOAD=1
  elif [[ "$arg" =~ ^[0-9]+$ ]]; then KEEP="$arg"; fi
done

STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p backups
OUT="backups/miv-${STAMP}.dump"
DB_USER="$(get_env POSTGRES_USER)"; DB_USER="${DB_USER:-miv}"
DB_NAME="$(get_env POSTGRES_DB)"; DB_NAME="${DB_NAME:-miv}"

docker compose exec -T postgres pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc > "$OUT"
SIZE="$(du -h "$OUT" | cut -f1)"
echo "$(date '+%F %T') 已备份 ${OUT}（${SIZE}）"

# 异地副本：推到七牛私有桶独立前缀（与业务对象隔离，走同一私有桶的鉴权）
if [ "$UPLOAD" = "1" ]; then
  KEY="backups/db/$(basename "$OUT")"
  REGION="$(get_env QINIU_REGION)"; REGION="${REGION:-z0}"
  # run --rm 临时起 api 容器算上传凭证（exec 要求服务常驻，run 不依赖）
  TOKEN="$(docker compose run --rm --no-deps api node -e '
    const { createHmac } = require("node:crypto");
    const b64u = (v) => Buffer.from(v).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
    const policy = b64u(JSON.stringify({ scope: `${process.env.QINIU_BUCKET}:${process.argv[1]}`,
      deadline: Math.floor(Date.now() / 1000) + 600 }));
    process.stdout.write(`${process.env.QINIU_ACCESS_KEY}:${b64u(createHmac("sha1", process.env.QINIU_SECRET_KEY).update(policy).digest())}:${policy}`);
  ' "$KEY")"
  curl -sf --retry 3 -F "token=$TOKEN" -F "key=$KEY" -F "file=@$OUT" \
    "https://up-${REGION}.qiniup.com/" > /dev/null
  echo "$(date '+%F %T') 异地副本已上传 qiniu://${KEY}"
fi

# 只保留最近 KEEP 份（本地；异地副本的保留策略在七牛侧按生命周期规则配置）
ls -1t backups/miv-*.dump 2>/dev/null | tail -n "+$((KEEP + 1))" | while read -r old; do
  rm -f "$old"
  echo "$(date '+%F %T') 已清理过期备份 ${old}"
done

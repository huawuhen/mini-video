# 部署手册（M2-OPS-01）

> 给非程序员的照做手册：从一台全新的 Ubuntu 服务器到产品上线运行。
> 服务器要求：Ubuntu 20.04+（amd64）、2 核 4G 起（生成排队期间较空闲，瓶颈在上游渠道）、40G 磁盘、能访问外网。
> 全程只需复制粘贴命令；「端口 8080」可换成自己的，正式域名见第 8 步。

## 0. 你需要提前准备的东西

| 项 | 说明 | 在哪拿 |
|---|---|---|
| 服务器 SSH 账号 | Ubuntu，能 sudo | 你的云厂商 |
| 七牛 AK/SK | 对象存储密钥（桶 redith-h5） | 七牛控制台「密钥管理」 |
| aiide 渠道 API Key | 视频生成渠道 | aiide 平台 |
| 智谱 LLM API Key | 故事理解（OpenAI 兼容） | 智谱开放平台 |
| 两个强密码 | ① 数据库密码（自己编）② 管理员后台密码（自己编，≥12 位） | 自己生成 |

## 1. 装 Docker（一次性）

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER   # 加完重新登录一次 SSH 生效
docker compose version          # 能打印版本号就成功了
```

## 2. 拿代码

```bash
sudo mkdir -p /srv/mini-video && sudo chown $USER /srv/mini-video
cd /srv/mini-video
git clone https://github.com/huawuhen/mini-video .
```

## 3. 写配置文件（唯一的编辑步骤）

```bash
cp deploy/.env.production.example deploy/.env   # 用这份纯生产模板（根目录 server/.env.example 是开发用，别混）
nano deploy/.env        # 或 vi；只改下面列出的行，其余保持默认
```

必改的行（在文件里搜名字）：

| 配置 | 填什么 |
|---|---|
| `POSTGRES_PASSWORD` | 自己编的强密码①。**只用字母和数字**（不要 `$ : / @ #` 等特殊字符），否则 `DATABASE_URL` 需要 URL 编码容易出错；同一个密码要填进 `DATABASE_URL` 的对应位置 |
| `CHANNEL_SECRET_KEY` | 服务器上跑 `openssl rand -base64 32` 的输出。**⚠️ 生成后立刻抄到密码管理器或纸上离线保存：它丢了，数据库里已保存的所有渠道密钥都无法解开，只能逐个重新录入** |
| `QINIU_ACCESS_KEY` / `QINIU_SECRET_KEY` | 七牛 AK / SK |
| `AIIDE_API_KEY` | aiide 渠道密钥 |
| `STORY_LLM_API_KEY` | 智谱密钥（`STORY_LLM_BASE_URL`/`MODEL` 已预填） |
| `ALLOWED_ORIGINS` | 你的站点地址，如 `https://video.example.com`（没域名先填 `http://服务器IP:8080`） |
| `COOKIE_SECURE` | **用 IP + HTTP 内测阶段保持 `false`**（填 true 浏览器在 http 下不回传 Cookie，会登录不上）；**启用 HTTPS 后必须改成 `true`**（见第 8 步），否则会话 Cookie 可经明文传输 |

保持默认即可的重点（勿删）：`NODE_ENV=production`、`TRUST_PROXY_HOPS=1`（前面加了一层外部代理/CDN 时要调大，见第 8 步）、`QINIU_BUCKET=redith-h5`、`QINIU_DOMAIN=https://cdnh5.redith.cn`、`QINIU_REGION=z0`、`PROJECTS_VIDEO_DOWNLOAD_TIMEOUT_MS=1200000`（渠道结果下载跨境较慢，5 分钟缺省不够）、`SMS_PROVIDER=log`（短信通道上线前的占位，验证码会打进日志，**正式上线前必须接入真实短信**）。

保存退出（nano：Ctrl+O 回车，Ctrl+X）。

## 4. 构建并启动（约 5~15 分钟，首次拉依赖最慢）

```bash
cd /srv/mini-video/deploy
docker compose up -d --build
```

启动顺序自动完成：PostgreSQL 健康检查 → 数据库迁移（migrate 一次性容器）→ API / Worker / Web。
看到全部 Up 后核对：

```bash
docker compose ps                      # 5 个服务，api/postgres 显示 healthy
curl -s http://localhost:8080/ | head  # 能输出 HTML 即 Web 正常
```

## 5. 首次部署清单（只做一次）

```bash
# ① 创建管理员（用户名自己起；密码②；提示「已创建管理员」即成功）
docker compose run --rm api node scripts/admin-create.js ops 你的管理员密码

# ② 写入生成渠道（aiide 视频/图片生效、智谱 LLM；表非空时会自动跳过）
docker compose run --rm api node scripts/channel-cli.js seed

# ③ 核对渠道（应看到 aiide/zhipu 为 * 生效、不含 local-mock 字样）
docker compose run --rm api node scripts/channel-cli.js list
```

> 第 ③ 步看不到「local-mock」就是对的：它是联调专用模拟驱动，生产镜像在构建时就断言拒绝加载它（镜像构建日志里有 `driver check ok: aiide-ark,...` 一行即为证明）。如果哪天在生产的渠道列表里看到 local-mock，立刻停下来检查 `NODE_ENV` 是否被改成了非 production。

管理员后台：浏览器打开 `http://服务器IP:8080/api/v1/admin`（接口文档见 docs/API.md §8；后台页面 M3 上线）。管理员登录限流：同一 IP 10 分钟内错 5 次会封禁 2 小时。

## 6. 日常运维

```bash
# 看日志（验证码在 api 日志里，grep sms）
docker compose logs -f api worker

# 发版更新（先测后合的 main 分支）
cd /srv/mini-video && git pull && cd deploy && docker compose up -d --build

# 重启（不影响数据）
docker compose restart api worker

# 停止（数据保留在 docker 卷里）
docker compose down
```

## 7. 备份与恢复（重要！）

```bash
# 手动备份一次（文件在 deploy/backups/）
cd /srv/mini-video/deploy && ./backup.sh

# 备份并推异地副本（上传到七牛私有桶独立前缀 backups/db/，与业务数据隔离；
# 服务器整机故障时异地仍在）
./backup.sh --upload

# 自动每天备份 + 异地副本：安装定时任务
crontab -e   # 加入下面一行（每天 04:00，本地保留 14 份）
0 4 * * * cd /srv/mini-video/deploy && ./backup.sh --upload >> backups/backup.log 2>&1
```

异地副本（七牛上的 `backups/db/` 前缀）的保留期限在七牛控制台对该前缀配「生命周期规则」即可（如 90 天自动删除）。注意备份在私有桶里同样受签名保护，但**任何备份文件都绝不提交进 git 仓库**（`.gitignore` 已全局拦截 `*.dump`）。

恢复（按需选用）：

```bash
cd /srv/mini-video/deploy
./restore.sh backups/miv-20261029-132759.dump            # 覆盖恢复（推荐）
./restore.sh backups/miv-20261029-132759.dump --recreate # 整库重建（更彻底，会先清空）
docker compose restart api worker                        # 恢复后必须重启
```

> **恢复演练的安全规矩**：演练一律在**一次性空库**上做（例如临时改 `compose.yml` 里 postgres 的库名或起一套 `docker compose -p miv-drill` 临时栈），**绝不能拿存有真实渠道密钥/用户数据的生产库演练**，避免备份文件把真实数据带出服务器。

## 8. 正式域名与 HTTPS（上线前）

1. 域名 DNS A 记录指向服务器 IP。
2. 最简单的 HTTPS：云厂商（阿里云/腾讯云）免费 SSL 证书 + 在服务器前再加一层 nginx/caddy，或者直接用云 CDN 回源 8080。
3. 改 `deploy/.env`：`ALLOWED_ORIGINS=https://你的域名`；**`COOKIE_SECURE=true`（必须改，否则会话 Cookie 走明文）**；然后 `docker compose up -d`。

### 加了外层代理/CDN 后：TRUST_PROXY_HOPS 必须核对

`TRUST_PROXY_HOPS` 决定后端从 `X-Forwarded-For` 里取第几跳当真实客户端 IP。填错会把**代理机器的 IP 当成所有用户的 IP**——管理员登录 5 次失败会封禁「全站」2 小时、短信/接口限流也会全站共享。

| 部署形态 | 填什么 |
|---|---|
| 只有 Compose 自带的 web（nginx）一层代理 | `1`（默认） |
| 外面又加了一层 nginx / caddy（共两层代理） | `2` |
| 云 CDN（如阿里云 CDN / CloudFlare）回源 | 按该 CDN 的回源头规则：多数为 `2`（CDN → web 容器 → api），以核对结果为准 |

**核对方法**（管理员后台上线前，用一次「故意输错密码」来看后端认出的 IP；只输错 1 次，离封禁的 5 次很远）：

1. 在**你自己的电脑**上（不要在服务器上）先查本机公网 IP：`curl ifconfig.me`
2. 同一台电脑上故意用错误密码登录一次管理端（把域名换成你的）：

```bash
curl -s -X POST https://你的域名/api/v1/admin/auth/login \
  -H 'Origin: https://你的域名' -H 'Content-Type: application/json' \
  -d '{"username":"ip-check","password":"wrong"}'
```

3. 在服务器上查后端记下的 IP：

```bash
docker compose exec -T postgres psql -U miv -d miv -c \
  "SELECT created_at, detail->>'ip' AS ip FROM admin_audit_logs WHERE action = 'auth.login_failed' ORDER BY created_at DESC LIMIT 3;"
```

如果 `ip` 和第 1 步查到的公网 IP 一致，说明配置正确；如果是内网/代理 IP（如 `172.x.x.x`、`192.168.x.x` 或 CDN 节点 IP），把 `TRUST_PROXY_HOPS` 加 1，`docker compose up -d` 后重做第 2、3 步。

## 9. 常见问题

| 现象 | 处理 |
|---|---|
| `migrate` 容器 Error | `docker compose logs migrate` 看原因；多半是 `.env` 没填全（数据库密码/ALLOWED_ORIGINS/SMS_PROVIDER） |
| 打开 8080 是 502 | `docker compose ps` 看 api 是否 healthy；`docker compose logs web` 看反代错误 |
| 用户收不到验证码 | 当前是 `SMS_PROVIDER=log` 占位：验证码在 `docker compose logs api \| grep sms:log`；正式上线接入真实短信后解决 |
| 生成一直「排队中」 | 上游渠道排队可达 12~79 分钟属正常；超过 2 小时看 `docker compose logs worker` |
| 想临时切到备用渠道 | `docker compose run --rm api node scripts/channel-cli.js use video miaowuai`（只影响新提交，在途任务仍回原渠道完成） |
| 想零费用演练全流程 | 本机开发环境用 `compose.mock-verify.yml`（见仓库注释）；生产环境禁止 |

## 附：本机（Mac）验证部署

```bash
cd deploy
docker compose -f compose.yml -f compose.mock-verify.yml up -d --build
# 验证码：docker compose logs api | grep sms:dev
# 用手机号+验证码登录 http://localhost:8080 走完整流程（local-mock 渠道，零真实费用）
docker compose -f compose.yml -f compose.mock-verify.yml down -v   # 用完清空
```

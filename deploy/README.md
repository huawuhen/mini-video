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
cp server/.env.example deploy/.env
nano deploy/.env        # 或 vi；只改下面列出的行，其余保持默认
```

必改的行（在文件里搜名字）：

| 配置 | 填什么 |
|---|---|
| `POSTGRES_PASSWORD` | 自己编的强密码①（同时把它填进 `DATABASE_URL` 里两处相同位置） |
| `CHANNEL_SECRET_KEY` | 在服务器上跑 `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` 的输出（没有 node 就随便一段 ≥32 位随机字符串）。**⚠️ 生成后立刻抄到密码管理器或纸上离线保存：它丢了，数据库里已保存的所有渠道密钥都无法解开，只能逐个重新录入** |
| `QINIU_ACCESS_KEY` / `QINIU_SECRET_KEY` | 七牛 AK / SK |
| `AIIDE_API_KEY` | aiide 渠道密钥 |
| `STORY_LLM_API_KEY` | 智谱密钥（`STORY_LLM_BASE_URL`/`MODEL` 已预填） |
| `ALLOWED_ORIGINS` | 你的站点地址，如 `https://video.example.com`（没域名先填 `http://服务器IP:8080`） |

保持默认即可的重点（勿删）：`NODE_ENV=production`、`TRUST_PROXY_HOPS=1`、`QINIU_BUCKET=redith-h5`、`QINIU_DOMAIN=https://cdnh5.redith.cn`、`QINIU_REGION=z0`、`PROJECTS_VIDEO_DOWNLOAD_TIMEOUT_MS=1200000`（渠道结果下载跨境较慢，5 分钟缺省不够）、`SMS_PROVIDER=log`（短信通道上线前的占位，验证码会打进日志，**正式上线前必须接入真实短信**）。

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

# 自动每天备份：安装定时任务
crontab -e   # 加入下面一行（每天 04:00 备份，保留 14 份）
0 4 * * * cd /srv/mini-video/deploy && ./backup.sh >> backups/backup.log 2>&1
```

恢复（演练过的流程，手册保持与脚本一致）：

```bash
cd /srv/mini-video/deploy
./restore.sh backups/miv-20261029-132759.dump            # 覆盖恢复（推荐）
./restore.sh backups/miv-20261029-132759.dump --recreate # 整库重建（更彻底，会先清空）
docker compose restart api worker                        # 恢复后必须重启
```

备份文件也要异地存一份（拷到云存储/另一台机器）：`backups/` 目录整体拷走即可。

## 8. 正式域名与 HTTPS（上线前）

1. 域名 DNS A 记录指向服务器 IP。
2. 最简单的 HTTPS：云厂商（阿里云/腾讯云）免费 SSL 证书 + 在服务器前再加一层 nginx/caddy，或者直接用云 CDN 回源 8080。
3. 改 `deploy/.env` 的 `ALLOWED_ORIGINS=https://你的域名`，然后 `docker compose up -d`。

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

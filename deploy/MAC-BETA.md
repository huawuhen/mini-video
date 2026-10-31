# Mac 本机内测手册（M2-OPS-03）

> 给非程序员的日常操作卡：这台 Mac 就是内测服务器，家人手机连**同一个 Wi-Fi** 打开
> `http://192.168.10.249:8080` 即可使用（不对外网开放）。Mac 不能合盖休眠、不能关机。
> 首次搭建见文末「附：首次搭建记录」；日常只用下面几条。

## 1. 每天开机后启动 / 晚上停止

```bash
# 启动（约 30 秒；只启动一次，重复执行没坏处）
cd /Users/wuhen/Documents/mini-video/deploy
docker compose -f compose.yml -f compose.mac-beta.yml up -d

# 防休眠（开机后执行一次；重启 Mac 后要重新执行）
caffeinate -dims &

# 停止（内测结束或要合盖带走 Mac 时）
docker compose -f compose.yml -f compose.mac-beta.yml stop
```

启动后核对（应看到 5 个服务，api/postgres/dns 显示 healthy）：

```bash
docker compose -f compose.yml -f compose.mac-beta.yml ps
```

## 2. 用户说「收不到验证码」

内测阶段短信是日志占位：验证码打在 api 容器日志里，由你转告用户。

```bash
docker compose -f compose.yml -f compose.mac-beta.yml logs api --since 5m | grep sms:log
# 输出形如：[sms:log] 138****3101 的验证码是 123456（占位通道，5 分钟内有效）
```

（同一手机号 60 秒内只能发一次；每手机每天 10 条上限。）

## 3. 给内测用户发余额（兑换码）

```bash
cd /Users/wuhen/Documents/mini-video/deploy
# 生成 2 张 50 元兑换码，有效期 365 天（金额只能是整数元）
docker compose -f compose.yml -f compose.mac-beta.yml run --rm api node scripts/redeem-create.js 50 2
```

⚠️ **码只显示这一次**（数据库只存哈希，丢了无法找回）：立刻复制发给用户（微信即可）。
用户在 App「钱包 → 兑换码」输入即到账。每批生成都有审计记录（不含码本身）。

## 4. 看费用 / 排队情况

```bash
# 渠道健康度与成本标注（* 是当前生效渠道）
docker compose -f compose.yml -f compose.mac-beta.yml run --rm api node scripts/channel-cli.js list

# 生成进度与排队（正在做第几段）
docker compose -f compose.yml -f compose.mac-beta.yml logs worker --since 10m | grep -E 'segment|poll'

# 内测成本账本（真实渠道花费，累计不要超过 250 元停止线）
cat /Users/wuhen/Documents/mini-video/server/.data/ops03-cost-ledger.jsonl
```

## 5. 生成渠道出问题时切换（应急）

```bash
# 查看可用渠道 → 切到备用（只影响新提交的作品；在途作品仍回原渠道完成）
docker compose -f compose.yml -f compose.mac-beta.yml run --rm api node scripts/channel-cli.js list
docker compose -f compose.yml -f compose.mac-beta.yml run --rm api node scripts/channel-cli.js use video miaowuai
# 切回 aiide
docker compose -f compose.yml -f compose.mac-beta.yml run --rm api node scripts/channel-cli.js use video aiide
```

## 6. 备份

每天 04:00 自动备份（已配置 crontab，前提是 Mac 处于 caffeinate 防休眠状态），文件在
`deploy/backups/`。手动备份一次：

```bash
cd /Users/wuhen/Documents/mini-video/deploy && ./backup.sh
```

恢复方法见 `deploy/README.md` 第 7 节（内测数据丢了也可接受，别慌）。

## 7. 手机访问不了时按顺序查

1. Mac 上 `docker compose -f compose.yml -f compose.mac-beta.yml ps`——5 个服务都在跑？
2. 手机和 Mac 连的是**同一个 Wi-Fi**？（路由器开了「AP 隔离」会互相看不到，找路由器设置关掉）
3. Mac 的局域网 IP 变了？（换 Wi-Fi 后会变：`ipconfig getifaddr en5` 看当前 IP，
   变了要改 `deploy/.env` 里的 `ALLOWED_ORIGINS` 并 `docker compose -f compose.yml -f compose.mac-beta.yml up -d`）

## 8. 管理员后台

`http://192.168.10.249:8080/api/v1/admin`（管理员账号 mac-beta，密码在开发 Agent 的密码库；
登录 5 次失败会封禁该 IP 2 小时——忘了密码别连着试）。

---

## 附：首次搭建记录（已完成，日常不用重复）

1. **网络前提**：Mac 的代理软件是 TUN fake-IP 模式，会让 Docker 容器把一切域名解析成
   198.18.x.x 假地址（被安全防护拦截）。解法是加了一个只走 443 的 DoH 转发容器
   （`deploy/doh-forwarder.mjs` + `compose.mac-beta.yml`），**没有放宽任何安全防护**。
   如果换了代理软件或关闭 TUN 模式，这个转发器也无需改动（它只是透明解析）。
2. 生产配置在 `deploy/.env`（含渠道密钥，绝不提交仓库；`COOKIE_SECURE=false` 是因为
   内测走 HTTP，将来上 HTTPS 必须改 true）。
3. 初始化已做：管理员 `mac-beta`、渠道种子（aiide 生效 / 喵呜备用 / 智谱 LLM）、
   `channel:list` 核对过 **local-mock 未加载**（生产镜像构建时就会拒绝它）。
4. 首次部署完整流程见 `deploy/README.md`（Ubuntu 生产服务器部署用那份，Mac 内测不用）。

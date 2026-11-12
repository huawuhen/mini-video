# vidu 驱动（Vidu 开放平台 Q3 系列）

M3-ENG-01（2026-11-12）接入。官方文档 <https://platform.vidu.cn/docs/api-reference>（当日核对）。
计费为积分制：**1 积分 = 0.03125 元（32 积分 = 1 元）**；生成失败不计积分（含审核拒绝），
轮询返回的 `credits` 透传为 `usage.credits` 供成本校准。

## 能力表（2026-11-12 核对，后续以官方文档为准）

| 模型 | 参考生 | 文生 | 时长（秒） | 分辨率 | 提示词上限 | 720p 参考单价 |
|---|---|---|---|---|---|---|
| `viduq3-turbo`（缺省） | ✔ | ✔ | 参考 3~15 / 文生 1~16 | 540p/720p/1080p | 5000 字 | 10 积分 ≈ 31 分/秒（错峰 5 积分） |
| `viduq3` | ✔ | ✘ | 参考 3~16 | 540p/720p/1080p | 20000 字 | 12 积分 ≈ 38 分/秒（错峰 6 积分） |
| `viduq3-pro` | ✘ | ✔ | 文生 1~16 | 540p/720p/1080p | 20000 字 | 图生 20 积分 ≈ 63 分/秒（错峰 10 积分） |

`viduq3-pro-fast`（仅图生）、`viduq3-mix`（仅参考生、720p 起步、24 积分/秒）暂未开放：
配置这两个值会在渠道创建时被拒。**Q4 Preview 经用户决策放弃（2026-11-12），不接入。**

## 接口选型与管线对接

- 产品提示词按「图N 主体参考（锁定外貌与服装）」语义拼装（`engine/skills` assemble 模板），
  与参考生（`POST /ent/v2/reference2video`，1~7 张主体参考 + 多机位一致性）能力对齐：
  **有参考图一律走参考生**；无参考图回退文生（`POST /ent/v2/text2video`，仅 turbo/pro 支持）。
- **尾帧衔接弱化**：上一段尾帧仍按管线口径排在参考图第 1 位，但在 Vidu 语义下是「主体参考条件」
  而非首帧，不保证首帧精确衔接（产品口径本就是「尽力而为」，见 ARCHITECTURE §4）。
- 参考图上限 7 张（管线默认上限 9）：保序截断（尾帧优先），超出量记 `vidu_ref_truncated` 日志。
  8~9 个形象的极端分段会丢后面的形象参考——出现频率高时应把 `maxImageRefs` 收到 7（待定）。
- **无音频参考入参**：`audioRefs` 不进请求体（`refAudio: 0`）。台词与背景音由 `audio=true`
  （缺省）音视频直出，对白原文已在提示词中；**跨段角色音色一致性**目前依赖模型自动推荐，
  后续如需锁定需引入 voice_id / 声音复刻（300 积分/音色，前 10 个免费）——遗留项见 handoff §4。
- 分辨率映射：产品 SKU `480p` → Vidu `540p`（只升不降），`720p`/`1080p` 原样。
- 鉴权 `Authorization: Token <key>`（非 Bearer），经 transport 逐请求覆盖。
- 协议无创建幂等键：重提防护靠 `gen_tasks` 状态守卫（与 aiide-ark 相同）。

## 渠道参数（configSchema.params）

| 参数 | 缺省 | 说明 |
|---|---|---|
| `model` | `viduq3-turbo` | 也可 `modelMap.video` 配置（优先）；可选 `viduq3` / `viduq3-pro` |
| `audio` | `true` | 音视频直出；`false` 输出静音视频，且**不允许 `offPeak=true`**（官方限制） |
| `offPeak` | `false` | 错峰半价，**48 小时内出片**、可取消；交互路径必须 false。超产品轮询上限会按 unknown 冻结待对账 |
| `watermark` | `false` | 渠道侧「内容由AI生成」水印；成片 AI 标识由渲染层统一处理 |
| `requestTimeoutMs` | `180000` | 单次 HTTP 超时 |

## 成本参考（积分 → 分，1 积分 = 3.125 分）

渠道 `cost_fen` 建议按此登记（对账口径，`channel.cost_fen` 键为逻辑 SKU）：

| 逻辑 SKU | Vidu 档 | 即时 | 错峰 |
|---|---|---|---|
| `video.480p`（售价 100 分/秒） | turbo 参考 540p = 7 积分 | ≈22 分/秒 | ≈12.5 分/秒 |
| `video.720p`（售价 200 分/秒） | turbo 参考 720p = 10 积分 | ≈31 分/秒 | ≈15.6 分/秒 |

对比原主力 aiide（720p 实测成本 151 分/秒）：即时口径约降至 1/5，错峰约 1/10。

## 配置步骤（默认渠道切换）

```bash
# 1. 录入渠道（凭证只写不读；baseUrl 必须官方 API 根地址）
node scripts/channel-cli.js create --kind video --driver vidu --name vidu-q3 \
  --baseUrl https://api.vidu.cn --credential <Vidu API Token> \
  --modelMap '{"video":"viduq3-turbo"}'
# 2. 连通测试（免费余额接口，返回积分余额与并发上限）
node scripts/channel-cli.js test --name vidu-q3
# 3. 渠道路由把 vidu-q3 排到第 1 位（rank 1 即默认），或运营后台「渠道管理」页操作
```

前置：已充值 Vidu 积分套餐（最低 500 元 = 16000 积分 ≈ 4800 秒 720p）；套餐自带并发 ≤5，
放量需商务定制。

## 未验证（真实渠道，待授权）

- 真实提交/轮询/取消回放、真实错误码形态（夹具按官方文档示例构造，非真实录制）。
- 台词音画同步质量、跨段音色一致性、智能切镜与分段拼接的观感。
- 官方文档小出入待实测确认：定价页参考生 turbo 时长写 3~16s、接口页写 3~15s（驱动按 15 上限收紧）；
  `viduq3-mix` 见于定价但接口枚举未见。
- 真实冒烟需充值并向用户报备费用上限后进行（AGENTS §6）。

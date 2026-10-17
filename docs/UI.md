# 界面规范（v1.0，2026-10-16，对应 PRD v2.2）

## 1. 原则

- **移动端优先**：先按 375×812 设计和验证，再适配 PC。
- **PC 必须可用**：≥1024px 时左侧导航 + 居中内容区（最大宽度 1200px）；作品详情页改为左右两栏（左：故事与片段流，右：大屏预览 / 操作）。
- **浅色清新**：白色卡片放在浅灰背景上，青绿色作主色，暖橙色只用于最关键的行动按钮（一键生成、确认并开始制作、去充值）。
- **零参数**：界面不出现模型名、分辨率、Seed、时长选择等技术参数；只有「风格」「画质」两个选择，均带中文名、示例和价格。
- **一屏一件事**：每个确认点只问一个问题；主操作固定在底部操作栏（手机）或右侧栏底部（PC）。
- 文案中文、口语化；不出现内部 ID、错误码、JSON（只放「技术详情」折叠区）。

## 2. 设计令牌（唯一来源：`apps/web/src/styles/tokens.css`）

| 令牌 | 值 | 用途 |
|---|---|---|
| `--miv-primary` | `#14B8A6` | 主色（按钮、选中、进度） |
| `--miv-primary-strong` | `#0F9488` | 按下态、强调文字 |
| `--miv-primary-soft` | `#E7F8F5` | 选中背景、标签底色 |
| `--miv-accent` / `--miv-accent-soft` | `#FF8A5B` / `#FFF1EA` | 关键行动按钮 / 价格提示底色 |
| `--miv-bg` | `#F5F7FA` | 页面背景 |
| `--miv-surface` | `#FFFFFF` | 卡片 |
| `--miv-text` / `-2` / `-3` | `#1F2933` / `#5B6775` / `#9AA4B0` | 正文 / 次要 / 辅助 |
| `--miv-border` | `#E6EAEF` | 分割线、描边 |
| `--miv-success` / `--miv-warning` / `--miv-danger` | `#22C55E` / `#F59E0B` / `#EF4444` | 状态色 |
| `--miv-on-primary` | `#FFFFFF` | 主色/强调色上的文字 |
| `--miv-overlay` | `rgba(15, 23, 32, 0.62)` | 新手引导遮罩 |
| `--miv-radius-sm` / `md` / `lg` | `8px` / `12px` / `16px` | 圆角 |
| `--miv-space-1..6` | `4 / 8 / 12 / 16 / 24 / 32px` | 间距 |

Vant 主题变量在 `tokens.css` 中映射到上述令牌。组件内禁止硬编码色值（包括 `#fff`），新颜色先加令牌。

## 3. 断点与导航

| 名称 | 宽度 | 布局 |
|---|---|---|
| mobile | <768px | 底部 Tabbar 4 项：首页 / 资产库 / 作品 / 我的；单栏；底部固定操作栏 |
| tablet | 768–1023px | 同 mobile，内容区最大宽度 720px 居中 |
| desktop | ≥1024px | 左侧固定导航 220px：首页、我的数字资产库、我的作品、钱包、我的；内容区最大宽度 1200px |

使用 `useBreakpoint()` 判断，不在组件里直接读 `window.innerWidth`。

## 4. 页面地图

| 路由 | 页面 | 登录 | 说明（PRD 章节） |
|---|---|---|---|
| `/` | 首页（创作主页） | 否（点「一键生成」时要求登录） | 范例轮播、故事输入、数字资产托盘、风格、画质、价格区间、一键生成（5.1）；首次登录自动开始新手引导（5.8） |
| `/assets` | 我的数字资产库 | 是 | 标签「数字人」「声音」（5.2） |
| `/assets/new` | 新建数字人 | 是 | 昵称、标签、照片 0~5 张或文字描述、默认声音、选风格生成形象（4.1） |
| `/assets/:id` | 数字人详情 | 是 | 参考照片、各风格形象与版本、默认声音、重命名、删除 |
| `/projects` | 我的作品 | 是 | 分组：进行中 / 待确认 / 已完成 / 失败 / 已过期；到期倒计时（5.6） |
| `/projects/:id` | 作品详情 | 是 | 按状态切换视图，见 §5 |
| `/wallet` | 钱包 | 是 | 余额、冻结、「充值」按钮（M3，PRD 6.4）、兑换码、流水 |
| `/wallet/recharge` | 充值 | 是 | 选金额（预设档）→ 选支付宝 / 微信支付 → 确认；PC 展示二维码，手机跳转收银页；微信 / 支付宝内置浏览器提示改用系统浏览器（M3） |
| `/wallet/recharge/result` | 充值结果 | 是 | 读取 `orderId`，每 2 秒轮询订单状态，最长 2 分钟；到账后显示新余额并提供「返回继续」（回到 `back` 页面）；超时提示结果确认中（M3） |
| `/me` | 我的 | 否 | 账号、钱包入口、重新查看新手引导、协议、退出 |
| `/login` | 登录 | – | 手机号 + 验证码 + 同意协议；成功后回到 `redirect` |

## 5. 作品详情视图（按 `status`）

顶部 `FlowSteps` 五步：写故事 → 确认故事 → 确认角色 → 制作中 → 成片。

| 状态 | 视图 | 主按钮 |
|---|---|---|
| `understanding` | `UnderstandingView`：动态文案「AI 正在细读您的故事…」「正在构想画面…」 | 无（可暂停） |
| `story_review` | `StoryReviewView`：梗概、精简提示、角色表（可纠正匹配）、「预计成片 N 秒 · 共 M 段」、视频费；可编辑故事后「重新整理」 | 「确认，下一步」（需要新形象时先弹形象费报价） |
| `casting` | `CastReviewView` 只读 + 形象生成中骨架 | 无 |
| `cast_review` | `CastReviewView`：每个角色一行（形象 + 声音；`voicesEnabled=false` 时隐藏声音）；费用明细（形象费已付 + 视频费 = 总价）与余额 | 「确认并开始制作」/ 余额不足「去充值」 |
| `rendering` / `composing` | `ProducingView`：「正在为您生成第 2/3 段视频与自然原声…」，已完成片段可先预览；后台保活提示 | 无（可暂停） |
| `delivered` | `DeliveryView`：播放器、保存到手机、复制链接、保存期提示条、片段列表（版本切换、改剧情、重新生成） | 「保存到手机」 |
| `expired` | `DeliveryView` 置灰：「已过期，视频已清理」，保留封面和故事 | 「用这个故事再做一部」 |
| `paused` / `failed` / `canceled` | 状态卡片 + 原因 + 技术详情折叠区 | 「继续」/「重试」 |

## 6. 组件清单（`src/components/`）

| 组件 | 说明 |
|---|---|
| `SpotlightTour` | 新手引导：遮罩 + 镂空高亮 + 气泡；由 `useTour()` 驱动，目标元素用 `data-tour="<key>"` 标记（§7） |
| `FlowSteps` | 作品五步进度（手机横向，PC 竖向） |
| `CharacterTray` | 首页数字人托盘：横滑头像、多选、末尾「+ 新建数字人」 |
| `StylePicker` / `QualityPicker` | 风格卡片横滑 / 画质分段选择（带「约 X 元/30 秒」） |
| `VoicePicker` | 音色选择底部弹层：分类筛选、试听、选中；`VoicePlayButton` 为试听按钮（同一时间只播放一个） |
| `CastRow` | 确认点 A/B 的角色行：头像、名字、匹配来源、形象版本切换、声音 |
| `SegmentCard` | 交付页片段卡：版本切换、改剧情、重新生成 |
| `ExpiryBanner` | 保存期提示条与倒计时 |
| `ProjectCard` / `StatusTag` / `PriceTag` | 作品卡片 / 状态标签 / 金额（分 → 元） |
| `StickyActionBar` / `EmptyState` / `MediaPlaceholder` | 底部操作栏 / 空状态 / 媒体占位 |

## 7. 新手引导实现约定（PRD 5.8）

- 目标元素加 `data-tour="story-input" | "character-tray" | "style-picker" | "quality-picker" | "generate-button" | "story-confirm" | "cast-voice" | "cast-pricing" | "delivery-save"`。
- 主引导在首页、`user.onboarding.tourCompletedAt === null` 时自动开始；完成或跳过调用 `PATCH /me/onboarding { tourCompleted: true }`。
- 场景小提示在首次进入对应视图时出现一次（`tipsSeen` 不含该 key），关闭后调用 `{ tipSeen }`。
- 镂空用一个 `position: fixed` 的高亮框 + 超大 `box-shadow`（颜色 `--miv-overlay`）实现，随 `resize` / `scroll` 重新计算位置；目标不在视口内先 `scrollIntoView`。
- 气泡自动选择空间足够的一侧；手机优先上 / 下。主引导中点遮罩不关闭，点高亮区只进入下一步（高亮框之上覆盖一层透明拦截层）。
- 键盘：←/→ 切步、Esc 跳过；焦点锁定在气泡内；`prefers-reduced-motion` 时去掉过渡。
- 引导期间不弹到期提醒等其他弹窗（`useTour().active` 为 true 时跳过）。

## 8. 交互要点

- 所有收费操作：先取报价 → 弹窗（明细 + 合计 + 余额）→ 用户确认才提交；余额不足直接引导去充值，充值后回到原页面（`useCharge`）。
- 首页价格只显示区间「预计 X~Y 元，确认故事后给出准确价格」，点「一键生成」不弹收费窗。
- 生成中的卡片显示骨架屏和进度文字，不允许重复点击。
- 替换操作完成后提示「已切换到新版本，可随时切回」。
- 登录拦截：未登录点击需登录的功能时跳 `/login?redirect=…`，登录后返回，**不自动触发收费或创建操作**；首页草稿（故事、选择）保存在 `sessionStorage`，登录回来后还原。
- 音频：试听使用单例 `<audio>`，切换页面时停止。

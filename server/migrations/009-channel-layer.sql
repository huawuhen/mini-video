-- M2-BE-03 上游渠道层（ARCHITECTURE §5.5；用户 2026-10-23/24 决策，Lead 2026-10-24 裁决）：
--   驱动（代码，一协议一目录）与渠道（数据，一条记录）分离；凭证 AES-256-GCM 加密存库；
--   路由每种能力同一时刻一个生效渠道，其余备用，不自动启用、不探活、不自动故障转移；
--   切换只影响新提交（gen_tasks.channel_id 绑定，轮询/对账回原渠道）；SKU 与渠道解耦。
-- 渠道记录不在迁移里播种：首次部署用环境变量种子（npm run channel:seed 或 CHANNEL_AUTO_SEED=true），之后以数据库为准。

-- 管理员账号（独立于 C 端用户；首个管理员由 npm run admin:create 创建，不开放注册）
CREATE TABLE admin_users (
  id            text PRIMARY KEY,
  username      text NOT NULL UNIQUE,
  password_hash text NOT NULL,                    -- scrypt：<hex salt>$<hex hash>（见 channels/admin-auth.js）
  display_name  text NOT NULL DEFAULT '',
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- 管理员会话（独立 Cookie miv_admin；只存 token 哈希，口径同 sessions）
CREATE TABLE admin_sessions (
  token_hash  text PRIMARY KEY,
  admin_id    text NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  csrf_token  text NOT NULL,
  expires_at  timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- 管理操作审计（后台 / CLI / 种子引导全部留痕；不记明文凭证）
CREATE TABLE admin_audit_logs (
  id          bigserial PRIMARY KEY,
  admin_id    text REFERENCES admin_users(id),
  actor       text NOT NULL,                      -- 'admin' | 'cli' | 'seed' | 'trial'
  action      text NOT NULL,                      -- channel.create / channel.update / channel.disable / route.set ...
  target_type text NOT NULL,
  target_id   text NOT NULL,
  detail      jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_audit_logs_target_idx ON admin_audit_logs (target_type, target_id, id DESC);

-- 渠道（数据）：一条记录 = 驱动 + 地址 + 密钥 + 模型映射 + 参数 + 成本。
-- 同协议的新供应商只是新增记录，零代码；retired = 软删除（在途任务清空前凭证保留可轮询）。
CREATE TABLE provider_channels (
  id            text PRIMARY KEY,
  kind          text NOT NULL CHECK (kind IN ('video', 'image', 'llm')),
  name          text NOT NULL,
  driver        text NOT NULL,                    -- server/src/engine/providers/drivers/<driver>/
  base_url      text NOT NULL,
  credential_enc text NOT NULL,                   -- AES-256-GCM（主密钥 CHANNEL_SECRET_KEY）；接口只回传后 4 位
  model_map     jsonb NOT NULL DEFAULT '{}',      -- 如 { "video": "dreamina-seedance-2-5-hc" }；Skill 选型与目录对账用
  params        jsonb NOT NULL DEFAULT '{}',      -- 驱动 configSchema.params 声明的其余参数（超时/档位等）
  cost_fen      jsonb NOT NULL DEFAULT '{}',      -- 渠道成本：{ "video.480p": 68, "image.look": 36 }（Lead 裁决③：成本进渠道）
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'retired')),
  remark        text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, name)                             -- channel:use -- <kind> <渠道名> 按名定位
);

-- 路由：(kind, capability) 一份有序渠道列表；capability='*' 为该 kind 的默认路由。
-- rank 最小的「active 且驱动存在」渠道为生效渠道，其余备用（备用不自动启用，用户 2026-10-24 决定）。
CREATE TABLE channel_routes (
  kind       text NOT NULL CHECK (kind IN ('video', 'image', 'llm')),
  capability text NOT NULL DEFAULT '*',
  channel_id text NOT NULL REFERENCES provider_channels(id),
  rank       integer NOT NULL,
  PRIMARY KEY (kind, capability, channel_id)
);

-- 真实请求统计（只记实际发生的提交/查询，不发探测请求；供 channel:list / 后台健康度）
CREATE TABLE channel_events (
  id          bigserial PRIMARY KEY,
  channel_id  text NOT NULL REFERENCES provider_channels(id),
  gen_task_id text,
  outcome     text NOT NULL CHECK (outcome IN ('submitted', 'succeeded', 'failed', 'unknown', 'query_failed')),
  latency_ms  integer,
  error_code  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX channel_events_recent_idx ON channel_events (channel_id, id DESC);

-- 任务绑定渠道：提交时写入；切换只影响新提交，在途回原渠道（停用/软删除渠道仍可轮询直到在途清空）
ALTER TABLE gen_tasks ADD COLUMN channel_id text REFERENCES provider_channels(id);
CREATE INDEX gen_tasks_channel_inflight_idx ON gen_tasks (channel_id) WHERE status IN ('submitting', 'running');

-- SKU 与渠道解耦（Lead 2026-10-24 裁决③）：SKU 只表达「逻辑能力 + 用户价」，model/channel 仅留档（'logical'），
-- 成本移入 provider_channels.cost_fen；此后换渠道只改渠道数据，不再写 SKU 迁移。
-- 售价沿用迁移 008（用户 2026-10-23 委托定价、Lead 2026-10-24 追认）：480p 100 分/秒、720p 200 分/秒、形象 60 分/张。
-- model 置空：Skill 选型改为按「当前生效视频渠道的 model_map.video」解析（M2-BE-03），不再依赖 SKU 行。
INSERT INTO skus (id, sku_code, version, kind, model, channel, resolution, unit, price_fen, cost_fen, durations, with_audio, audio_ref) VALUES
  ('sku_logical480p00001', 'video.480p', 1, 'video',  '', 'logical', '480p', 'second', 100, 0, '{5,10,15,30}', true, true),
  ('sku_logical720p00001', 'video.720p', 1, 'video',  '', 'logical', '720p', 'second', 200, 0, '{5,10,15,30}', true, true),
  ('sku_logicallook00001', 'image.look', 1, 'image', '', 'logical', '1k',   'image',  60,  0, '{}',           true, true)
ON CONFLICT (sku_code, version) DO NOTHING;

-- 档位映射指向逻辑 SKU（覆盖 004/006/007/008 的全部历史指向；mapping 行 id 不变，既有作品仍按锁定映射取当前生效版本）
UPDATE tier_mappings SET version = version + 1, video_sku_code = 'video.480p'
  WHERE tier_id = 'standard' AND video_sku_code <> 'video.480p';
UPDATE tier_mappings SET version = version + 1, video_sku_code = 'video.720p'
  WHERE tier_id = 'hd' AND video_sku_code <> 'video.720p';

-- 形象计价指向逻辑 SKU（settings 缺行时补种）
INSERT INTO settings (key, value) VALUES ('look_image_sku_code', '"image.look"')
  ON CONFLICT (key) DO UPDATE SET value = '"image.look"', updated_at = now();

-- 渠道绑定的旧 SKU 全部下线（历史行与既有报价快照 / gen_tasks.request.amountFen 不受影响）
UPDATE skus SET status = 'inactive' WHERE channel <> 'logical' AND kind IN ('video', 'image') AND status = 'active';

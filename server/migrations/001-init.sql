-- 001-init：全量初始表结构 + 种子数据（docs/ARCHITECTURE.md §3，PRD v2.2）
-- 约定：时间 timestamptz；JSON jsonb；金额 bigint（分）；ID 为带前缀 text（应用层生成，见 src/db/ids.js）。
-- 已发布后不得修改本文件；结构变化新增 002-*.sql。

-- ───────────── 账号 ─────────────
CREATE TABLE users (
  id                text PRIMARY KEY,
  phone             text NOT NULL UNIQUE,
  nickname          text NOT NULL,
  avatar_key        text,
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  tour_completed_at timestamptz,                         -- null：首页自动开始新手引导（PRD 5.8）
  tips_seen         text[] NOT NULL DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sms_codes (
  id          bigserial PRIMARY KEY,
  phone       text NOT NULL,
  code_hash   text NOT NULL,
  expires_at  timestamptz NOT NULL,
  attempts    integer NOT NULL DEFAULT 0,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sms_codes_phone_idx ON sms_codes (phone, created_at DESC);

CREATE TABLE sessions (
  token_hash   text PRIMARY KEY,
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token   text NOT NULL,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

-- 通用固定窗口计数器：短信、登录、免费故事理解等限流（key 形如 sms:phone:138...、understand:usr_xxx）
CREATE TABLE rate_counters (
  key          text NOT NULL,
  window_start timestamptz NOT NULL,
  count        integer NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);

-- ───────────── 钱包 ─────────────
CREATE TABLE wallets (
  user_id       text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  available_fen bigint NOT NULL DEFAULT 0 CHECK (available_fen >= 0),
  frozen_fen    bigint NOT NULL DEFAULT 0 CHECK (frozen_fen >= 0),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ledger (
  id               text PRIMARY KEY,
  user_id          text NOT NULL REFERENCES users(id),
  kind             text NOT NULL CHECK (kind IN ('recharge', 'redeem', 'reserve', 'settle', 'refund', 'charge', 'adjust')),
  amount_fen       bigint NOT NULL,            -- 对可用余额的变化（扣减为负）
  frozen_delta_fen bigint NOT NULL DEFAULT 0,  -- 对冻结金额的变化
  title            text NOT NULL,
  ref_type         text,
  ref_id           text,
  idempotency_key  text NOT NULL UNIQUE,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_user_idx ON ledger (user_id, created_at DESC, id DESC);
CREATE INDEX ledger_ref_idx ON ledger (ref_type, ref_id);

CREATE TABLE redeem_codes (
  code_hash  text PRIMARY KEY,
  amount_fen bigint NOT NULL CHECK (amount_fen > 0),
  expires_at timestamptz,
  used_by    text REFERENCES users(id),
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ───────────── 计价与目录 ─────────────
CREATE TABLE skus (
  id           text PRIMARY KEY,
  sku_code     text NOT NULL,
  version      integer NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('video', 'image', 'llm')),
  model        text NOT NULL,
  channel      text NOT NULL,
  resolution   text,
  unit         text NOT NULL CHECK (unit IN ('second', 'image', 'ktoken')),
  price_fen    bigint NOT NULL CHECK (price_fen >= 0),  -- 用户价（分/单位）；llm 固定 0（平台承担）
  cost_fen     bigint NOT NULL DEFAULT 0 CHECK (cost_fen >= 0),
  durations    integer[] NOT NULL DEFAULT '{}',          -- 视频可选单段时长（秒）
  with_audio   boolean NOT NULL DEFAULT true,            -- 原生音频
  audio_ref    boolean NOT NULL DEFAULT true,            -- 接受参考音频
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  effective_at timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sku_code, version),
  CHECK (kind <> 'llm' OR price_fen = 0),
  CHECK (kind <> 'video' OR (unit = 'second' AND cardinality(durations) > 0))
);

CREATE TABLE quality_tiers (
  id     text PRIMARY KEY,
  name   text NOT NULL,
  note   text NOT NULL DEFAULT '',
  sort   integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive'))
);

CREATE TABLE tier_mappings (
  id             text PRIMARY KEY,
  tier_id        text NOT NULL REFERENCES quality_tiers(id),
  version        integer NOT NULL,
  video_sku_code text NOT NULL,
  effective_at   timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tier_id, version)
);

CREATE TABLE styles (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  cover_key   text,
  prompt_hint text NOT NULL DEFAULT '',   -- 给 engine 的风格描述，不对用户展示
  sort        integer NOT NULL DEFAULT 0,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive'))
);

CREATE TABLE voices (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  category      text NOT NULL CHECK (category IN ('girl', 'boy', 'child_f', 'child_m', 'young_f', 'young_m', 'middle_f', 'middle_m', 'elder_f', 'elder_m')),
  gender        text NOT NULL CHECK (gender IN ('female', 'male')),
  age_group     text NOT NULL CHECK (age_group IN ('child', 'teen', 'young', 'middle', 'elder')),
  description   text NOT NULL DEFAULT '',
  sample_key    text,          -- 试听音频（5~10 秒）
  ref_audio_key text,          -- 供模型引用的参考音频
  language      text NOT NULL DEFAULT 'zh-CN',
  sort          integer NOT NULL DEFAULT 0,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive'))
);

CREATE TABLE settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE quotes (
  id             text PRIMARY KEY,
  user_id        text NOT NULL REFERENCES users(id),
  kind           text NOT NULL CHECK (kind IN ('cast_looks', 'project_render', 'look_regenerate', 'segment_take')),
  ref_type       text NOT NULL,
  ref_id         text NOT NULL,
  params_hash    text NOT NULL,
  amount_fen     bigint NOT NULL CHECK (amount_fen >= 0),
  breakdown      jsonb NOT NULL,
  price_snapshot jsonb NOT NULL,
  expires_at     timestamptz NOT NULL,
  consumed_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX quotes_user_idx ON quotes (user_id, created_at DESC);

-- ───────────── 数字资产库 ─────────────
CREATE TABLE uploads (
  id            text PRIMARY KEY,
  user_id       text NOT NULL REFERENCES users(id),
  kind          text NOT NULL CHECK (kind IN ('image')),
  storage_key   text NOT NULL,
  mime          text NOT NULL,
  size_bytes    bigint NOT NULL,
  referenced_at timestamptz,                 -- 被数字人引用后设置；24 小时未引用的由 uploads.sweep 清理
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX uploads_unreferenced_idx ON uploads (created_at) WHERE referenced_at IS NULL;

CREATE TABLE characters (
  id               text PRIMARY KEY,
  user_id          text NOT NULL REFERENCES users(id),
  name             text NOT NULL,
  tags             text[] NOT NULL DEFAULT '{}',
  description      text NOT NULL DEFAULT '',
  default_voice_id text REFERENCES voices(id),
  deleted_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX characters_user_idx ON characters (user_id, created_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE character_photos (
  id           text PRIMARY KEY,
  character_id text NOT NULL REFERENCES characters(id),
  upload_id    text NOT NULL REFERENCES uploads(id),
  sort         integer NOT NULL DEFAULT 0,
  UNIQUE (character_id, upload_id)
);

CREATE TABLE character_looks (
  id                  text PRIMARY KEY,
  character_id        text NOT NULL REFERENCES characters(id),
  style_id            text NOT NULL REFERENCES styles(id),
  selected_version_id text,
  UNIQUE (character_id, style_id)
);

CREATE TABLE look_versions (
  id          text PRIMARY KEY,
  look_id     text NOT NULL REFERENCES character_looks(id),
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  gen_task_id text,
  image_key   text,
  view_keys   text[] NOT NULL DEFAULT '{}',
  error       jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX look_versions_look_idx ON look_versions (look_id, created_at);
ALTER TABLE character_looks ADD CONSTRAINT character_looks_selected_fk
  FOREIGN KEY (selected_version_id) REFERENCES look_versions(id) DEFERRABLE INITIALLY DEFERRED;

-- ───────────── 作品 ─────────────
CREATE TABLE projects (
  id              text PRIMARY KEY,
  user_id         text NOT NULL REFERENCES users(id),
  title           text NOT NULL DEFAULT '',
  story_text      text NOT NULL,
  source_type     text NOT NULL CHECK (source_type IN ('text', 'file')),
  style_id        text NOT NULL REFERENCES styles(id),
  quality_tier_id text NOT NULL REFERENCES quality_tiers(id),
  tier_mapping_id text NOT NULL REFERENCES tier_mappings(id),   -- 创建时锁定（PRD 4.6）
  ratio           text NOT NULL DEFAULT '9:16' CHECK (ratio IN ('9:16', '16:9', '1:1')),
  status          text NOT NULL CHECK (status IN ('understanding', 'story_review', 'casting', 'cast_review', 'rendering',
                    'composing', 'delivered', 'expired', 'paused', 'failed', 'canceled')),
  paused_from     text,
  error           jsonb,                       -- { code, message, step }
  progress        jsonb NOT NULL DEFAULT '{"percent":0,"message":""}',
  story           jsonb,                       -- StoryResult + engine 原始输出
  selected_character_ids text[] NOT NULL DEFAULT '{}',   -- 首页托盘勾选
  delivered_at    timestamptz,
  expires_at      timestamptz,
  deleted_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'paused' OR paused_from IS NOT NULL)
);
CREATE INDEX projects_user_idx ON projects (user_id, updated_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX projects_expiry_idx ON projects (expires_at) WHERE status = 'delivered';

CREATE TABLE project_cast (
  id              text PRIMARY KEY,
  project_id      text NOT NULL REFERENCES projects(id),
  idx             integer NOT NULL,
  name            text NOT NULL,
  description     text NOT NULL DEFAULT '',
  gender          text NOT NULL DEFAULT 'unknown' CHECK (gender IN ('female', 'male', 'unknown')),
  age_group       text NOT NULL DEFAULT 'young' CHECK (age_group IN ('child', 'teen', 'young', 'middle', 'elder')),
  character_id    text REFERENCES characters(id),
  match_source    text NOT NULL CHECK (match_source IN ('user', 'ai', 'new')),
  look_version_id text REFERENCES look_versions(id),
  voice_id        text REFERENCES voices(id),
  voice_source    text CHECK (voice_source IN ('user', 'ai', 'default')),
  locked_at       timestamptz,                 -- 确认点 B 后锁定
  UNIQUE (project_id, idx)
);
-- 同一作品内两个角色不能用同一音色（PRD 4.7）
CREATE UNIQUE INDEX project_cast_voice_uniq ON project_cast (project_id, voice_id) WHERE voice_id IS NOT NULL;

CREATE TABLE segments (
  id               text PRIMARY KEY,
  project_id       text NOT NULL REFERENCES projects(id),
  idx              integer NOT NULL,
  duration_seconds integer NOT NULL CHECK (duration_seconds > 0),
  plot             text NOT NULL,
  camera_notes     text NOT NULL DEFAULT '',
  dialogue         jsonb NOT NULL DEFAULT '[]',   -- [{ castId, line }]
  ambience         text NOT NULL DEFAULT '',
  transition       text NOT NULL DEFAULT 'hard_cut' CHECK (transition IN ('prev_tail', 'hard_cut')),
  cast_ids         text[] NOT NULL DEFAULT '{}',
  final_prompt     jsonb,                         -- bindPrompts 输出
  selected_take_id text,
  UNIQUE (project_id, idx)
);

CREATE TABLE segment_takes (
  id             text PRIMARY KEY,
  segment_id     text NOT NULL REFERENCES segments(id),
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'unknown')),
  gen_task_id    text,
  video_key      text,
  poster_key     text,
  last_frame_key text,
  error          jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX segment_takes_segment_idx ON segment_takes (segment_id, created_at);
ALTER TABLE segments ADD CONSTRAINT segments_selected_take_fk
  FOREIGN KEY (selected_take_id) REFERENCES segment_takes(id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE renders (
  id               text PRIMARY KEY,
  project_id       text NOT NULL REFERENCES projects(id),
  takes_snapshot   jsonb NOT NULL,              -- 拼接时使用的 take id 列表
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  video_key        text,
  cover_key        text,
  duration_seconds integer,
  error            jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX renders_project_idx ON renders (project_id, created_at DESC);

-- SSE 补发与审计：每次状态迁移写一条，并 NOTIFY project_events
CREATE TABLE project_events (
  id         bigserial PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id),
  status     text NOT NULL,
  progress   jsonb NOT NULL,
  changed    text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX project_events_project_idx ON project_events (project_id, id);

-- ───────────── 任务与审计 ─────────────
CREATE TABLE gen_tasks (
  id              text PRIMARY KEY,
  user_id         text NOT NULL REFERENCES users(id),
  kind            text NOT NULL CHECK (kind IN ('llm', 'image', 'video')),
  sku_code        text,
  sku_version     integer,
  provider        text NOT NULL,
  upstream_id     text,
  status          text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'submitting', 'running', 'succeeded', 'failed', 'unknown')),
  request         jsonb NOT NULL,
  result          jsonb,
  error           jsonb,
  cost_fen        bigint NOT NULL DEFAULT 0,
  idempotency_key text NOT NULL UNIQUE,
  next_poll_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gen_tasks_poll_idx ON gen_tasks (next_poll_at) WHERE status = 'running';

CREATE TABLE jobs (
  id           bigserial PRIMARY KEY,
  type         text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}',
  dedupe_key   text UNIQUE,                     -- 同一业务动作只入队一次（null 不去重）
  run_at       timestamptz NOT NULL DEFAULT now(),
  attempts     integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  locked_by    text,
  locked_until timestamptz,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_ready_idx ON jobs (run_at) WHERE status = 'queued';
CREATE INDEX jobs_lease_idx ON jobs (locked_until) WHERE status = 'running';

CREATE TABLE audit_logs (
  id         bigserial PRIMARY KEY,
  actor_id   text,
  action     text NOT NULL,
  target     text,
  outcome    text NOT NULL,
  request_id text,
  detail     jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_id, created_at DESC);

-- ───────────── 种子数据 ─────────────
-- 运营配置（PRD 4.2 / 8.1 / 9.6）；标【默认】的值后续由用户确认，可在后台修改
INSERT INTO settings (key, value) VALUES
  ('max_duration_seconds',      '90'),
  ('daily_free_understanding',  '20'),
  ('retention_days',            '90'),
  ('expiry_remind_days',        '7'),
  ('quote_ttl_seconds',         '900'),
  ('min_story_chars',           '5'),
  ('max_story_chars',           '3000'),
  ('max_character_photos',      '5'),
  ('look_image_sku_code',       '"image.mock.2k"'),
  ('default_ratio',             '"9:16"');

-- 首批 6 种风格（PRD 4.5，用户 2026-10-16 确认）；封面图待运营上传
INSERT INTO styles (id, name, description, prompt_hint, sort) VALUES
  ('realistic',    '真人写实',    '接近真实拍摄的家庭影像',       'photorealistic, natural lighting, cinematic home video', 10),
  ('manga_drama',  '漫剧',        '国漫或短剧漫画风，适合剧情类', 'Chinese manhua drama style, bold line art, dramatic lighting', 20),
  ('cartoon_3d',   '卡通 3D',     '类皮克斯 3D 动画，温馨',       '3D animated film style, soft lighting, warm and cute', 30),
  ('anime',        '日系动漫',    '2D 赛璐璐',                    'Japanese anime, cel shading, vivid colors', 40),
  ('picture_book', '绘本水彩',    '儿童绘本质感',                 'children picture book, watercolor texture, gentle palette', 50),
  ('clay',         '黏土 / 定格', '趣味风格',                     'claymation, stop-motion, handmade clay texture', 60);

-- 画质档位（PRD 4.6）
INSERT INTO quality_tiers (id, name, note, sort) VALUES
  ('standard', '标准', '清晰流畅', 10),
  ('hd',       '高清', '画面更细腻', 20);

-- 【占位】模拟渠道 SKU 与价格，仅供 M1 开发联调；M0 验证后由新迁移/后台配置真实 SKU 并切换档位映射
INSERT INTO skus (id, sku_code, version, kind, model, channel, resolution, unit, price_fen, cost_fen, durations) VALUES
  ('sku_mockvideo720p01', 'video.mock.720p',  1, 'video', 'mock-video', 'mock', '720p',  'second', 20, 0, '{5,10,15,30}'),
  ('sku_mockvideo1080p1', 'video.mock.1080p', 1, 'video', 'mock-video', 'mock', '1080p', 'second', 40, 0, '{5,10,15,30}'),
  ('sku_mockimage2k0001', 'image.mock.2k',    1, 'image', 'mock-image', 'mock', '2k',    'image',  50, 0, '{}'),
  ('sku_mockllm00000001', 'llm.mock',         1, 'llm',   'mock-llm',   'mock', NULL,    'ktoken',  0, 0, '{}');

INSERT INTO tier_mappings (id, tier_id, version, video_sku_code) VALUES
  ('tm_standard00000001', 'standard', 1, 'video.mock.720p'),
  ('tm_hd00000000000001', 'hd',       1, 'video.mock.1080p');

-- 首批音色（PRD 4.7，用户 2026-10-16 确认）；试听与参考音频待运营上传后填 sample_key / ref_audio_key
INSERT INTO voices (id, name, category, gender, age_group, description, sort) VALUES
  ('vc_girl_gentle',   '温柔少女', 'girl',     'female', 'teen',   '轻柔细腻，适合温馨叙述', 10),
  ('vc_girl_lively',   '元气少女', 'girl',     'female', 'teen',   '明亮活泼，充满朝气',     11),
  ('vc_boy_sunny',     '阳光少年', 'boy',      'male',   'teen',   '开朗爽快',               20),
  ('vc_boy_calm',      '沉稳少年', 'boy',      'male',   'teen',   '安静沉着',               21),
  ('vc_childf_sweet',  '甜美女童', 'child_f',  'female', 'child',  '奶声奶气，甜甜的',       30),
  ('vc_childf_lively', '活泼女童', 'child_f',  'female', 'child',  '爱笑爱闹',               31),
  ('vc_childm_naughty','调皮男童', 'child_m',  'male',   'child',  '机灵调皮',               40),
  ('vc_childm_good',   '乖巧男童', 'child_m',  'male',   'child',  '懂事乖巧',               41),
  ('vc_youngf_smart',  '知性女声', 'young_f',  'female', 'young',  '温和知性',               50),
  ('vc_youngm_warm',   '温暖男声', 'young_m',  'male',   'young',  '温暖亲切',               60),
  ('vc_middlef_mom',   '慈爱妈妈', 'middle_f', 'female', 'middle', '温柔有耐心',             70),
  ('vc_middlem_dad',   '沉稳爸爸', 'middle_m', 'male',   'middle', '稳重可靠',               80),
  ('vc_elderf_grandma','和蔼奶奶', 'elder_f',  'female', 'elder',  '慈祥和蔼',               90),
  ('vc_elderm_grandpa','慈祥爷爷', 'elder_m',  'male',   'elder',  '慢悠悠，很亲切',         100);

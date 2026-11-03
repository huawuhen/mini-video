-- M3-LEGAL-01：用户同意记录（API.md §1「同意记录」）。只追加、不覆盖：
-- 每次同意都是一条新记录（用户、类型、版本、时间、IP），历史不可变（合规留痕）。
-- kind：terms = 《用户协议》《隐私政策》（登录 agreeTerms 时写入）；
--        photo = 人脸/儿童照片单独同意（POST /me/consents 写入）。
-- 「当前是否已同意」= 该 kind 最新一条的 version 是否等于服务端当前版本（版本升级后视为未同意）。

CREATE TABLE user_consents (
  id          text PRIMARY KEY,                    -- cns_ 前缀（newId）
  user_id     text NOT NULL REFERENCES users(id),
  kind        text NOT NULL CHECK (kind IN ('terms', 'photo')),
  version     text NOT NULL,
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_user_consents_user ON user_consents (user_id, kind, created_at DESC);

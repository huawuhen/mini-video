-- M3-ADM-04：价格与配置 / 审计（docs/API.md §8.4~8.5）。
-- ① 价格锁定（M3-ADM-03 复审发现的旧逻辑，TASKS M3-ADM-04 前置要求）：
--    作品确认点 B 消费报价时锁定视频单价（分/秒），之后 segment.generate、失败重试、
--    详情 pricing 一律按锁定价，与确认时预占的冻结额一致；改价（SKU 新版本生效）只影响
--    新报价。旧数据回填当前生效价（确认时点的最好近似；NULL 时代码回退原「当前价」行为）。
ALTER TABLE projects ADD COLUMN video_unit_fen integer;

UPDATE projects p
   SET video_unit_fen = (
     SELECT s.price_fen
       FROM tier_mappings tm
       JOIN skus s ON s.sku_code = tm.video_sku_code AND s.kind = 'video' AND s.status = 'active'
      WHERE tm.id = p.tier_mapping_id
      ORDER BY s.version DESC
      LIMIT 1)
 WHERE p.video_unit_fen IS NULL
   AND p.tier_mapping_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM project_confirm_log c WHERE c.project_id = p.id AND c.step = 'cast');

-- ② SKU 价格版本：管理端新增版本（不覆盖历史）记录操作人与幂等键
ALTER TABLE skus ADD COLUMN created_by text REFERENCES admin_users(id);
ALTER TABLE skus ADD COLUMN idempotency_key text;
CREATE UNIQUE INDEX skus_idempotency_uniq ON skus (idempotency_key) WHERE idempotency_key IS NOT NULL;

-- ③ 管理端上传（§8.4）：风格封面 / 音色试听与参考音频；管理员上传没有用户归属（user_id 空）
ALTER TABLE uploads DROP CONSTRAINT uploads_kind_check;
ALTER TABLE uploads ADD CONSTRAINT uploads_kind_check CHECK (kind IN ('image', 'audio'));
ALTER TABLE uploads ALTER COLUMN user_id DROP NOT NULL;

-- 风格封面 / 音色音频改为经管理端上传（uploads.id 引用），既有 *_key 列继续供用户端目录读签名链接
ALTER TABLE styles ADD COLUMN cover_upload_id text REFERENCES uploads(id);
ALTER TABLE voices ADD COLUMN sample_upload_id text REFERENCES uploads(id);
ALTER TABLE voices ADD COLUMN ref_audio_upload_id text REFERENCES uploads(id);

-- ④ 审计 IP（§8.5 响应字段；写操作时由会话中间件取请求 IP 记录）
ALTER TABLE admin_audit_logs ADD COLUMN ip text;

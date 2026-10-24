-- M2-BE-01：真实渠道 SKU 替换 mock 占位（用户 2026-10-22 定价决策，CODEX_HANDOFF §3）。
-- 标准 = seedance-2.5 480p，售 80 分/秒、渠道成本 39；高清 = 720p，售 150 分/秒、成本 47；
-- 形象图 = gpt-image-2.5-flare 1k/medium，售 50 分/张、成本 23。1080p 首批不开放（2.8 元/秒）。
-- tier_mappings 升版本指向真实 SKU：mapping 行 id 不变，既有作品的 tier_mapping_id 仍有效，
-- 计价按「锁定映射下当前生效 SKU」自动切到真实价（videoUnitFen / priceProjectRender 同源）。
INSERT INTO skus (id, sku_code, version, kind, model, channel, resolution, unit, price_fen, cost_fen, durations) VALUES
  ('sku_seedance480p0001', 'video.seedance.480p', 1, 'video', 'seedance-2.5', 'modelhub', '480p', 'second', 80, 39, '{5,10,15,30}'),
  ('sku_seedance720p0001', 'video.seedance.720p', 1, 'video', 'seedance-2.5', 'modelhub', '720p', 'second', 150, 47, '{5,10,15,30}'),
  ('sku_flare1k0000000001', 'image.flare.1k', 1, 'image', 'gpt-image-2.5-flare', 'modelhub', '1k', 'image', 50, 23, '{}');

UPDATE tier_mappings SET version = 2, video_sku_code = 'video.seedance.480p' WHERE tier_id = 'standard' AND video_sku_code = 'video.mock.720p';
UPDATE tier_mappings SET version = 2, video_sku_code = 'video.seedance.720p' WHERE tier_id = 'hd' AND video_sku_code = 'video.mock.1080p';

-- mock 视频/图片 SKU 下线（llm.mock 保留：无消费方，历史流水引用不受影响；skus 无外键指向）。
UPDATE skus SET status = 'inactive' WHERE channel = 'mock' AND kind IN ('video', 'image') AND status = 'active';

-- 运营配置同步：形象计价指向真实 SKU（value 为 jsonb 字符串；mock 下线后旧指向会 500）。
UPDATE settings SET value = '"image.flare.1k"', updated_at = now()
  WHERE key = 'look_image_sku_code' AND value = '"image.mock.2k"';

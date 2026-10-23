-- M2-BE-01 渠道切换（在 005-image-sku-gpt2 基础上叠加；modelhub 的 gpt-image-2 SKU 同步下线）：喵呜（miaowuai）SKU 替换 modelhub（用户 2026-10-22 决定更换 API 渠道）。
-- 模型与渠道成本（模型广场 default 分组 1X 快照，2026-10-22 核对，价格为元/秒转分）：
--   视频 seedance-2.5-deal：480p=0.375 元/秒（37.5 分，成本字段取整为 38）、720p=0.625 元/秒（62.5→63）；
--     SKU 成本按整数分向上取整，价格对账（price_audit）允许 ±1 分容差（渠道目录价无 API，快照人工核对）。
--   图片 GPT-image-2：1080p=0.05 元/张（成本 5）。
-- 售价沿用用户 2026-10-22 定价（480p 80 分/秒、720p 150 分/秒、形象 50 分/张）不变。
INSERT INTO skus (id, sku_code, version, kind, model, channel, resolution, unit, price_fen, cost_fen, durations) VALUES
  ('sku_miaowu480p000001', 'video.seedance25deal.480p', 1, 'video', 'seedance-2.5-deal', 'miaowuai', '480p', 'second', 80, 38, '{5,10,15,30}'),
  ('sku_miaowu720p000001', 'video.seedance25deal.720p', 1, 'video', 'seedance-2.5-deal', 'miaowuai', '720p', 'second', 150, 63, '{5,10,15,30}'),
  ('sku_gptimage2p000001', 'image.gptimage2.1080p', 1, 'image', 'GPT-image-2', 'miaowuai', '1080p', 'image', 50, 5, '{}');

UPDATE tier_mappings SET version = 3, video_sku_code = 'video.seedance25deal.480p'
  WHERE tier_id = 'standard' AND video_sku_code IN ('video.mock.720p', 'video.seedance.480p');
UPDATE tier_mappings SET version = 3, video_sku_code = 'video.seedance25deal.720p'
  WHERE tier_id = 'hd' AND video_sku_code IN ('video.mock.1080p', 'video.seedance.720p');

-- modelhub 与 flare 系 SKU 全部下线（历史流水引用不受影响；skus 无外键指向）。
UPDATE skus SET status = 'inactive' WHERE channel IN ('mock', 'modelhub') AND kind IN ('video', 'image') AND status = 'active';

-- 运营配置同步：形象计价指向新 SKU（jsonb 值；覆盖 002/004/005 各历史指向）。
UPDATE settings SET value = '"image.gptimage2.1080p"', updated_at = now()
  WHERE key = 'look_image_sku_code'
    AND value IN ('"image.mock.2k"', '"image.flare.1k"', '"image.gpt2.1k"');

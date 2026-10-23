-- M2-BE-01 渠道切换（在 006-miaowuai-skus 基础上叠加）：aiide 渠道替换喵呜（用户 2026-10-23 指定；
-- 文档 https://aiide.apifox.cn/chinese，定价页 https://www.aiide.com/zh/pricing/{dreamina-seedance-2-5-hc,gpt-image-2}）。
-- 模型：视频 dreamina-seedance-2-5-hc（火山方舟协议 /v1/video/generations）、图片 gpt-image-2（OpenAI Images）。
--
-- 成本口径（**估算，待真实冒烟按 usage.total_tokens 与渠道后台实际扣费校准**；汇率按 7.2 CNY/USD）：
--   视频按 token 计费 $9.63/M（定价页 2026-10-23）。Seedance 口径 token ≈ 宽×高×帧率(24)×秒 ÷ 1024：
--     480p 9:16 = 480×864 → 9,720 tok/s → $0.0936/s ≈ 67.4 分/s → 取 68；
--     720p 9:16 = 704×1248 → 20,592 tok/s → $0.1983/s ≈ 142.8 分/s → 取 143。
--     ⚠ 远高于喵呜（38/63）与 modelhub（39/47）：按现售价 80/150 分/秒几乎没有毛利，售价待用户决策。
--   图片按 token 计费：输出 $27/M（Official 9 折组；gpt-image-official 7 折组 $21/M）。1024×1024 中档约 1,056 输出 token
--     → $0.0285 ≈ 20.5 分/张 → 取 21（7 折组约 16）。
-- 售价沿用用户 2026-10-22 定价（480p 80 分/秒、720p 150 分/秒、形象 50 分/张）不变。
-- durations 沿用 {5,10,15,30}：30 秒整段在 modelhub seedance-2.5 已验证，aiide 路线待冒烟确认（不支持则由上游 400 → 片段失败）。
INSERT INTO skus (id, sku_code, version, kind, model, channel, resolution, unit, price_fen, cost_fen, durations) VALUES
  ('sku_aiide480p0000001', 'video.seedance25hc.480p', 1, 'video', 'dreamina-seedance-2-5-hc', 'aiide', '480p', 'second', 80, 68, '{5,10,15,30}'),
  ('sku_aiide720p0000001', 'video.seedance25hc.720p', 1, 'video', 'dreamina-seedance-2-5-hc', 'aiide', '720p', 'second', 150, 143, '{5,10,15,30}'),
  ('sku_aiideimg1k000001', 'image.gptimage2.1k', 1, 'image', 'gpt-image-2', 'aiide', '1k', 'image', 50, 21, '{}');

UPDATE tier_mappings SET version = 4, video_sku_code = 'video.seedance25hc.480p'
  WHERE tier_id = 'standard' AND video_sku_code IN ('video.mock.720p', 'video.seedance.480p', 'video.seedance25deal.480p');
UPDATE tier_mappings SET version = 4, video_sku_code = 'video.seedance25hc.720p'
  WHERE tier_id = 'hd' AND video_sku_code IN ('video.mock.1080p', 'video.seedance.720p', 'video.seedance25deal.720p');

-- 喵呜、modelhub、mock 系 SKU 全部下线（历史流水引用不受影响；skus 无外键指向）。
UPDATE skus SET status = 'inactive'
  WHERE channel IN ('mock', 'modelhub', 'miaowuai') AND kind IN ('video', 'image') AND status = 'active';

-- 运营配置同步：形象计价指向新 SKU（jsonb 值；覆盖 002/004/005/006 各历史指向）。
UPDATE settings SET value = '"image.gptimage2.1k"', updated_at = now()
  WHERE key = 'look_image_sku_code'
    AND value IN ('"image.mock.2k"', '"image.flare.1k"', '"image.gpt2.1k"', '"image.gptimage2.1080p"');

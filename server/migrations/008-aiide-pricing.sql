-- M2-BE-01 aiide 渠道定价（用户 2026-10-23 核对渠道后台实扣后授权「合理上涨 SKU」，由开发 Agent 定价并记录依据）。
-- 后台实扣（2026-10-23 冒烟）：gpt-image-2 两张合计 $0.10（$0.05/张）；5 秒 480p 视频 $0.46
--   （usage 48,437 tokens × $9.63/M = $0.4665，token 口径吻合，公式「宽×高×24fps×秒÷1024」误差 0.3%）。
-- 成本（汇率 7.2 CNY/USD，整数分向上取整）：
--   图片 $0.05 → 36 分/张（迁移 007 估 21 偏低，按实扣修正）；
--   视频 480p 67.2 → 68 分/秒（实测）；720p 按像素比例（704×1248 / 480×864 ≈ 2.12）≈ 142.3 → 143 分/秒（公式已验证）。
-- 售价：原 80 / 150 / 50 分在 aiide 成本下毛利仅约 15% / 5% / 28%，不足以覆盖片段失败重试（A 口径平台承担上游成本）、
--   支付费率、存储与 LLM；按「生成成本毛利 ≥ 30%」取整数元：
--   480p 100 分/秒（1.0 元，毛利 32%）、720p 200 分/秒（2.0 元，28.5%）、形象 60 分/张（40%）。
--   90 秒成片：标准 90 元、高清 180 元（原 72 / 135）。售价可由用户随时以新 version 调整。
-- 用 version 2 叠加、v1 下线：已有报价快照（quotes.price_snapshot）与 gen_tasks.request.amountFen 不受影响。
INSERT INTO skus (id, sku_code, version, kind, model, channel, resolution, unit, price_fen, cost_fen, durations) VALUES
  ('sku_aiide480p0000002', 'video.seedance25hc.480p', 2, 'video', 'dreamina-seedance-2-5-hc', 'aiide', '480p', 'second', 100, 68, '{5,10,15,30}'),
  ('sku_aiide720p0000002', 'video.seedance25hc.720p', 2, 'video', 'dreamina-seedance-2-5-hc', 'aiide', '720p', 'second', 200, 143, '{5,10,15,30}'),
  ('sku_aiideimg1k000002', 'image.gptimage2.1k', 2, 'image', 'gpt-image-2', 'aiide', '1k', 'image', 60, 36, '{}');

UPDATE skus SET status = 'inactive' WHERE channel = 'aiide' AND version = 1 AND status = 'active';

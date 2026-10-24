-- M2-BE-01 补充：形象图模型 2026-10-22 由 gpt-image-2.5-flare 更换为 gpt-image-2（用户指示）。
-- gpt-image-2 与 flare 同请求形态（独立 resolution 字段 + low/medium/high 档位），
-- 1k/medium 渠道成本 21 分（2026-10-22 实时目录），售价维持 50 分/张（用户 2026-10-22 定价）。
-- 004 已在开发/测试库应用，本迁移接管切换；不回改 004。
INSERT INTO skus (id, sku_code, version, kind, model, channel, resolution, unit, price_fen, cost_fen, durations) VALUES
  ('sku_gpt21k0000000001', 'image.gpt2.1k', 1, 'image', 'gpt-image-2', 'modelhub', '1k', 'image', 50, 21, '{}');

UPDATE skus SET status = 'inactive' WHERE sku_code = 'image.flare.1k' AND status = 'active';

-- 运营配置同步：形象计价指向新 SKU（flare 下线后旧指向会 500）。
UPDATE settings SET value = '"image.gpt2.1k"', updated_at = now()
  WHERE key = 'look_image_sku_code' AND value = '"image.flare.1k"';

-- M2-BE-03-e2e 实测校准（2026-10-24，Lead 裁决采用）：720p 真实 token 实测 108,900/5 秒段（两段完全一致，
--   端到端 `agent/be/M2-BE-03-e2e`）→ 21,780 tok/s，比迁移 008 的像素比例公式（704×1248×24÷1024 = 20,592 tok/s）
--   高 5.6%——上游按编码对齐计 token。按 $9.63/M、7.2 汇率折 ≈151 分/秒（151.0），取代公式推算的 143。
-- 落点：aiide-ark 视频渠道的 cost_fen（种子默认值在 worker.js 同步改 151，本迁移保证已有库生效）。
-- 480p 68 分/秒与逻辑 SKU 用户价（video.720p = 200 分/秒）均不变；只影响毛利核算口径。
UPDATE provider_channels
   SET cost_fen = jsonb_set(COALESCE(cost_fen, '{}'::jsonb), '{video.720p}', '151'::jsonb),
       updated_at = now()
 WHERE driver = 'aiide-ark' AND kind = 'video';

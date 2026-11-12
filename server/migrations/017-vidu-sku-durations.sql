-- M3-ENG-01（Vidu Q3 渠道接入，2026-11-12）：逻辑视频 SKU 单段时长收窄 {5,10,15,30} → {5,10,15}。
--
-- 背景：项目默认视频渠道切换为 Vidu Q3（用户 2026-11-12 决策）。Vidu 参考生单段上限
-- 15 秒（viduq3-turbo）/16 秒（viduq3），远低于原 30 秒档；而时长规划只看 SKU 的
-- allowedDurations（projects/understand.js，与渠道解耦），若保留 30 秒档，规划出的
-- 30 秒片段路由到 Vidu 后会在提交期全部失败（PROVIDER_INPUT_INVALID）。
--
-- 口径：
-- - 就地 UPDATE（不新增 version）：价格、分辨率、unit 均不变，仅收窄可选时长；
--   版本号语义是「用户价变更」（price-audit / 报价快照），时长不是价格维度。
-- - 在途作品不受影响：分段时长在建任务时已写入 gen_tasks.request（快照），
--   在途任务绑定原渠道（channel_id），轮询/结算口径不变。
-- - aiide（seedance 系 4~30 秒）同样回到 {5,10,15}：少一段超长档，规划层偏好长段
--   （preferredSegmentSeconds）会自动用多个 15 秒段补足总时长，秒价不变、总时长上限不变。
UPDATE skus SET durations = '{5,10,15}'
 WHERE channel = 'logical' AND kind = 'video' AND sku_code IN ('video.480p', 'video.720p');

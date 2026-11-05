-- M3-ADM-03：运营后台·待核对 take 的人工判定（docs/API.md §8.3）。
-- AGENTS §5：unknown 不自动重提、不自动退款，运营在渠道后台查明后人工判定一次：
--   not_charged → 退还该片段冻结、片段标 failed（用户可重新生成）；
--   charged     → 按原价结算该片段冻结、片段标 failed，作品时间线写「已核对：上游已计费」。
-- resolved_* 记录判定结论/说明/操作人/时间与幂等键：同一 take 只能判定一次
-- （同键重放返回首次结果，不同键重复判定 409 TAKE_ALREADY_RESOLVED）。

ALTER TABLE segment_takes
  ADD COLUMN resolved_outcome text CHECK (resolved_outcome IN ('not_charged', 'charged')),
  ADD COLUMN resolved_note text,
  ADD COLUMN resolved_key text,
  ADD COLUMN resolved_by text REFERENCES admin_users(id),
  ADD COLUMN resolved_at timestamptz;

CREATE INDEX segment_takes_unknown_idx ON segment_takes (status) WHERE status = 'unknown';

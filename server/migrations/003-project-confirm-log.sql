-- M1-BE-05：确认/控制操作的幂等日志（同作品同步骤同幂等键重放直接返回成功，不重复扣费）。
CREATE TABLE project_confirm_log (
  id              text PRIMARY KEY,
  project_id      text NOT NULL REFERENCES projects(id),
  step            text NOT NULL,
  idempotency_key text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, step, idempotency_key)
);

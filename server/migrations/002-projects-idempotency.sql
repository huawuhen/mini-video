-- M1-BE-05：作品创建幂等（同一用户同一幂等键重放返回同一作品，不重复消耗免费次数）。
ALTER TABLE projects ADD COLUMN idempotency_key text;
CREATE UNIQUE INDEX projects_idempotency_idx ON projects (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

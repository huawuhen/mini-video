-- M3-PAY-02：充值订单补列 + user_wechat 唯一约束修正（011 已发布不再修改，按惯例新增迁移）。
-- idempotency_key：同键重放返回同一订单（API §3.1）；
-- provider_data：微信侧产物（prepayId / codeUrl / h5Url），GET created 时按需生成支付参数。
-- M3-PAY-02 复审必改 1：openid 只用于付款、不是账号身份——家人共用微信付款、换手机号
-- 重新注册都合法，UNIQUE(appid, openid) 会把用户永久卡死（且前端按 409 重跳授权会死循环）。
-- 去掉唯一约束，改建普通索引（查「该 appid 下是否已有此 openid」仍高效）。

ALTER TABLE payment_orders ADD COLUMN idempotency_key text NOT NULL DEFAULT '';
-- 历史行（011~当前无真实数据）允许空串占位；新订单全部显式赋唯一键
CREATE UNIQUE INDEX idx_payment_orders_idem ON payment_orders (user_id, idempotency_key)
  WHERE idempotency_key <> '';
ALTER TABLE payment_orders ADD COLUMN provider_data jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE user_wechat DROP CONSTRAINT user_wechat_appid_openid_key;
CREATE INDEX idx_user_wechat_appid_openid ON user_wechat (appid, openid);

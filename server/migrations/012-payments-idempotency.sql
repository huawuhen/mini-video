-- M3-PAY-02：充值订单补列（011 已发布不再修改，按惯例新增迁移）。
-- idempotency_key：同键重放返回同一订单（API §3.1）；
-- provider_data：微信侧产物（prepayId / codeUrl / h5Url），GET created 时按需生成支付参数。

ALTER TABLE payment_orders ADD COLUMN idempotency_key text NOT NULL DEFAULT '';
-- 历史行（011~当前无真实数据）允许空串占位；新订单全部显式赋唯一键
CREATE UNIQUE INDEX idx_payment_orders_idem ON payment_orders (user_id, idempotency_key)
  WHERE idempotency_key <> '';
ALTER TABLE payment_orders ADD COLUMN provider_data jsonb NOT NULL DEFAULT '{}'::jsonb;

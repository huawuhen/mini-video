-- M3-ADM-02：运营后台·用户与余额 / 订单与人工退款（docs/API.md §8.1~8.2）。
-- ① users.status 增加 deactivated（注销，§8.1；注销不可恢复，删除会话与媒体文件、匿名保留记录）；
-- ② users.last_login_at（AdminUser.lastLoginAt，登录成功时回写）；
-- ③ ledger.admin_id / ledger.reason：客服调整（adjust）与人工退款登记的原因、操作人——
--    只在后台可见（§8.1 AdminLedgerItem.reason/adminUsername），用户侧流水接口不返回；
-- ④ payment_orders.refunded_fen（记录式退款累计，§8.2）与 last_notify_at（AdminOrder 详情
--    lastNotifyAt；通知/入账时回写）。

ALTER TABLE users DROP CONSTRAINT users_status_check;
ALTER TABLE users ADD CONSTRAINT users_status_check
  CHECK (status IN ('active', 'disabled', 'deactivated'));
ALTER TABLE users ADD COLUMN last_login_at timestamptz;

ALTER TABLE ledger ADD COLUMN admin_id text REFERENCES admin_users(id);
ALTER TABLE ledger ADD COLUMN reason text;

ALTER TABLE payment_orders ADD COLUMN refunded_fen bigint NOT NULL DEFAULT 0;
ALTER TABLE payment_orders ADD COLUMN last_notify_at timestamptz;

-- 管理端订单列表按创建时间倒序翻页（用户侧已有 (user_id, created_at) 索引，全局倒序缺索引）
CREATE INDEX idx_payment_orders_created ON payment_orders (created_at DESC, id DESC);

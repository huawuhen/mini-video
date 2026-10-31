-- M3-PAY-01：在线充值（微信支付 APIv3，PRD 6.4 / ARCHITECTURE「支付（M3）」）。
-- 金额一律整数分（amount_fen）；out_trade_no 即我方订单号（= id，微信侧唯一）；
-- credited_ledger_id 关联入账流水，重复通知靠 status 条件更新挡住（ARCHITECTURE 入账口径）。

CREATE TABLE payment_orders (
  id                text PRIMARY KEY,                    -- po_ 前缀（newId）
  user_id           text NOT NULL REFERENCES users(id),
  channel           text NOT NULL DEFAULT 'wechatpay',
  out_trade_no      text NOT NULL UNIQUE,                -- 微信下单用我方订单号
  transaction_id    text,                                -- 微信支付订单号（回调/查单回填）
  payer_openid      text,
  amount_fen        integer NOT NULL CHECK (amount_fen > 0),
  scene             text NOT NULL CHECK (scene IN ('jsapi', 'h5', 'native')),
  status            text NOT NULL DEFAULT 'created'
                    CHECK (status IN ('created', 'paid', 'expired', 'failed')),
  client_ip         text,
  expires_at        timestamptz NOT NULL,
  paid_at           timestamptz,
  credited_ledger_id text,                               -- 入账流水 id（ledger.id）
  notify_count      integer NOT NULL DEFAULT 0,
  last_notify       jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- 用户充值订单列表（新在前）
CREATE INDEX idx_payment_orders_user ON payment_orders (user_id, created_at DESC);
-- 对账任务扫描：未终态且已到期的订单（ARCHITECTURE：(status, expires_at) WHERE status='created'）
CREATE INDEX idx_payment_orders_reconcile ON payment_orders (status, expires_at) WHERE status = 'created';

-- 公众号静默授权（snsapi_base）得到的 openid：JSAPI 下单必需；每用户绑定一个，
-- 同一 appid+openid 只属于一个用户（UNIQUE(appid, openid)）
CREATE TABLE user_wechat (
  user_id     text PRIMARY KEY REFERENCES users(id),
  appid       text NOT NULL,
  openid      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (appid, openid)
);

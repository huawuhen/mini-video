// M3-PAY-01：公众号静默授权（snsapi_base）+ 支付方式可用性（scenes）+ 迁移 011 表结构。
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createWechatOAuth } from '../../src/payments/wechat-oauth.js';
import { resolveScenes } from '../../src/payments/scenes.js';
import { createTestDb } from '../helpers/db.js';

describe('createWechatOAuth（snsapi_base 静默授权）', () => {
  const httpOf = (payload) => async ({ url, method }) => {
    void method;
    if (!url.includes('code=good')) return { status: 200, text: async () => JSON.stringify(
      { errcode: 40029, errmsg: 'invalid code' }) };
    return { status: 200, text: async () => JSON.stringify(payload) };
  };

  test('authorizeUrl：官方格式（redirect_uri 编码、scope=snsapi_base、#wechat_redirect 结尾）', () => {
    const oauth = createWechatOAuth({ appid: 'wxAPPID', secret: 'secret' });
    const url = oauth.authorizeUrl({ redirectUri: 'https://example.com/api/v1/wechat/oauth/callback?x=1',
      state: 's1' });
    assert.ok(url.startsWith('https://open.weixin.qq.com/connect/oauth2/authorize?'), url);
    assert.ok(url.includes('appid=wxAPPID'));
    assert.ok(url.includes(`redirect_uri=${encodeURIComponent('https://example.com/api/v1/wechat/oauth/callback?x=1')}`));
    assert.ok(url.includes('response_type=code'));
    assert.ok(url.includes('scope=snsapi_base'));
    assert.ok(url.includes('state=s1'));
    assert.ok(url.endsWith('#wechat_redirect'));
  });

  test('openidByCode：code 有效换到 openid；无效 code 抛中文错误', async () => {
    const oauth = createWechatOAuth({ appid: 'wxAPPID', secret: 'secret',
      http: httpOf({ openid: 'oMockUserOpenid', scope: 'snsapi_base' }) });
    assert.equal((await oauth.openidByCode('good')).openid, 'oMockUserOpenid');
    await assert.rejects(() => oauth.openidByCode('bad'),
      (err) => err.code === 'OAUTH_CODE_INVALID' && err.message.includes('40029'));
  });

  test('缺 appid/secret 构造即拒绝', () => {
    assert.throws(() => createWechatOAuth({ appid: '', secret: 'x' }), /缺少/);
  });
});

describe('resolveScenes（缺配置 scenes=[]，API §3.1）', () => {
  const full = (over = {}) => ({
    payments: { mchid: 'm', privateKey: 'k', certSerial: 's', apiV3Key: 'a'.repeat(32),
      platformPublicKey: 'p', platformPublicKeyId: 'pid', notifyUrl: 'https://e/n', h5Enabled: false, ...over },
    wechatMp: { appid: 'wx1', secret: 'sec' },
  });

  test('全配置 + H5 开通 → [jsapi, h5, native]', () => {
    assert.deepEqual(resolveScenes(full({ h5Enabled: true })), ['jsapi', 'h5', 'native']);
  });

  test('全配置 + H5 未开通 → [jsapi, native]', () => {
    assert.deepEqual(resolveScenes(full()), ['jsapi', 'native']);
  });

  test('任一必填缺失 → []（在线充值整体关闭）', () => {
    for (const key of ['mchid', 'privateKey', 'certSerial', 'apiV3Key', 'platformPublicKey',
      'platformPublicKeyId', 'notifyUrl']) {
      const broken = full();
      broken.payments[key] = '';
      assert.deepEqual(resolveScenes(broken), [], `缺 ${key} 必须关闭`);
    }
    assert.deepEqual(resolveScenes({ payments: null, wechatMp: { appid: 'x', secret: 'y' } }), []);
    assert.deepEqual(resolveScenes(undefined), []);
  });

  test('公众号未配置 → 无 jsapi（H5/native 照常）', () => {
    assert.deepEqual(resolveScenes({ ...full({ h5Enabled: true }), wechatMp: { appid: '', secret: '' } }),
      ['h5', 'native']);
  });
});

describe('迁移 011：payment_orders 与 user_wechat', () => {
  let ctx;
  before(async () => { ctx = await createTestDb(); });
  after(async () => { await ctx.drop(); });

  test('payment_orders：落库/约束（金额正整数、状态枚举、scene 枚举、out_trade_no 唯一）', async () => {
    const { rows: user } = await ctx.db.query(
      `INSERT INTO users (id, phone, nickname) VALUES ('usr_pay00000000001', '15800000090', '测试') RETURNING id`);
    await ctx.db.query(
      `INSERT INTO payment_orders (id, user_id, out_trade_no, amount_fen, scene, expires_at)
       VALUES ('po_test0000000001', $1, 'po_test0000000001', 5000, 'jsapi', now() + interval '30 minutes')`,
      [user[0].id]);
    // out_trade_no 唯一
    await assert.rejects(() => ctx.db.query(
      `INSERT INTO payment_orders (id, user_id, out_trade_no, amount_fen, scene, expires_at)
       VALUES ('po_test0000000002', $1, 'po_test0000000001', 100, 'native', now())`, [user[0].id]),
      /duplicate key/);
    // 金额必须为正
    await assert.rejects(() => ctx.db.query(
      `INSERT INTO payment_orders (id, user_id, out_trade_no, amount_fen, scene, expires_at)
       VALUES ('po_test0000000003', $1, 'po_test0000000003', 0, 'h5', now())`, [user[0].id]),
      /check constraint/);
    // scene 枚举外拒绝
    await assert.rejects(() => ctx.db.query(
      `INSERT INTO payment_orders (id, user_id, out_trade_no, amount_fen, scene, expires_at)
       VALUES ('po_test0000000004', $1, 'po_test0000000004', 100, 'alipay', now())`, [user[0].id]),
      /check constraint/);
  });

  test('user_wechat：每用户一条，appid+openid 唯一', async () => {
    const { rows: users } = await ctx.db.query(
      `INSERT INTO users (id, phone, nickname) VALUES ('usr_pay00000000002', '15800000091', '测试') RETURNING id`);
    const insert = (uid) => ctx.db.query(
      `INSERT INTO user_wechat (user_id, appid, openid) VALUES ($1, 'wx1', $2)`,
      [uid, `o_${uid}`]);
    await insert('usr_pay00000000001');
    await insert('usr_pay00000000002');
    // 同一 openid 不能绑给第二个用户（同 appid 下 openid 唯一）
    await assert.rejects(() => ctx.db.query(
      `INSERT INTO user_wechat (user_id, appid, openid) VALUES ('usr_pay00000000002', 'wx1', 'o_usr_pay00000000001')`),
      /duplicate key/);
    // 同一用户重复插入 → 主键冲突（上层用 upsert 更新）
    await assert.rejects(() => insert('usr_pay00000000001'), /duplicate key/);
  });
});

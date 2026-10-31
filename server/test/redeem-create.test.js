// 兑换码生成 CLI（M2-OPS-03）：只存哈希、码只打印一次、写审计且审计不含码。
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createRedeemCodes, newCode, hashOf } from '../scripts/redeem-create.js';
import { createRedeemCodes as _guard } from '../scripts/redeem-create.js'; // ESM 单例检查占位
import { createTestDb } from './helpers/db.js';

void _guard;

describe('redeem:create（M2-OPS-03 兑换码生成）', () => {
  let ctx;
  before(async () => { ctx = await createTestDb(); });
  after(async () => { await ctx.drop(); });

  test('码格式可人工抄写（MIV-XXXXX-XXXXX，Crockford base32 无易混字符）', () => {
    for (let i = 0; i < 200; i += 1) {
      const code = newCode();
      assert.match(code, /^MIV-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
    }
  });

  test('生成并落库：数据库只存哈希（无明文）、数量金额正确、审计写入且不含码', async () => {
    const codes = await createRedeemCodes(ctx.db, { amountFen: 5000, count: 3, validDays: 30 });
    assert.equal(codes.length, 3);
    assert.equal(new Set(codes).size, 3, '不重复');
    // 只存哈希：库里能按哈希查到，且不含任何明文码
    const { rows } = await ctx.db.query(
      `SELECT code_hash, amount_fen, used_by, expires_at > now() AS valid FROM redeem_codes WHERE code_hash = ANY($1)`,
      [codes.map(hashOf)]);
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => r.amount_fen === 5000 && r.valid && r.used_by === null));
    const dump = JSON.stringify(rows);
    for (const code of codes) assert.ok(!dump.includes(code), '库里不得出现明文码');
    // 审计：写了一条批次记录，detail 不含码
    const audit = await ctx.db.query(
      `SELECT actor, action, detail FROM admin_audit_logs WHERE action = 'redeem.create'`);
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0].actor, 'redeem-create');
    const detail = JSON.stringify(audit.rows[0].detail);
    assert.match(detail, /"count":3/);
    for (const code of codes) assert.ok(!detail.includes(code), '审计不得含码');
    // 生成的码能被钱包侧兑换（哈希口径一致）
    const hit = await ctx.db.query(`SELECT 1 FROM redeem_codes WHERE code_hash = $1`, [hashOf(codes[0])]);
    assert.equal(hit.rows.length, 1);
  });
});

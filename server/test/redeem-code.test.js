// 兑换码规范化（M2-OPS-03 复审必改 2）：生成与兑换两侧共用的输入口径。
// 手机誊写的高频误差（小写、空格、横线丢失/错位、O↔0、I/L↔1）必须归一到同一哈希；
// 结构不合法返回 null，由兑换侧按「无效」处理。
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { normalizeRedeemCode, redeemCodeHash } from '../src/wallet/redeem-code.js';

const CANONICAL = 'MIV-F3TNN-PBSZW'; // 2026-10-31 内测实际发出的码（规范形式）

describe('normalizeRedeemCode', () => {
  test('规范形式原样返回', () => {
    assert.equal(normalizeRedeemCode(CANONICAL), CANONICAL);
  });

  test('手机誊写误差全部归一：小写/首尾空格/中间空格/全角空格/少横线/横线错位', () => {
    const variants = [
      'miv-f3tnn-pbszw',        // 全小写（手机输入法默认）
      '  MIV-F3TNN-PBSZW  ',    // 首尾空格
      'MIV F3TNN PBSZW',        // 中间空格（横线记成空格）
      'MIV-F3TNN PBSZW',        // 混合
      'MIV\u3000F3TNN\u3000PBSZW', // 全角空格（微信里复制常见）
      'MIVF3TNNPBSZW',          // 少横线
      'MIV-F3TNNPBSZW',         // 横线丢了一段
      'MIVF3TNN-PBSZW',         // 横线错位
      'miv—f3tnn—pbszw',        // 全角长横线
    ];
    for (const v of variants) assert.equal(normalizeRedeemCode(v), CANONICAL, `输入 ${JSON.stringify(v)} 应归一`);
  });

  test('易混字符按 Crockford 口径映射：O→0、I→1、L→1', () => {
    assert.equal(normalizeRedeemCode('MIV-ABCO1-DEFGH'), 'MIV-ABC01-DEFGH', 'O→0');
    assert.equal(normalizeRedeemCode('miv-abcI1-defgh'), 'MIV-ABC11-DEFGH', 'I→1（随小写）');
    assert.equal(normalizeRedeemCode('MIV-ABCL1-DEFGH'), 'MIV-ABC11-DEFGH', 'L→1');
  });

  test('结构不合法返回 null：长度/字符集/前缀不对、非字符串', () => {
    for (const bad of ['MIV-NOPE', 'MIV-F3TNN-PBSZ', 'MIV-F3TNN-PBSZWW', 'MIV-F3TNN-PBSZW9',
      'XX-AAAAA-BBBBB', 'AAAAAAAAAAAAAA', '', 'MIV-含中文', null, undefined, 12345]) {
      assert.equal(normalizeRedeemCode(bad), null, `${JSON.stringify(bad)} 应判 null`);
    }
  });

  test('哈希口径：所有誊写误差与规范形式哈希一致；历史码（生成即规范形式）哈希不变', () => {
    for (const v of ['miv-f3tnn-pbszw', ' MIVF3TNNPBSZW', 'MIV F3TNN-PBSZW']) {
      assert.equal(redeemCodeHash(v), redeemCodeHash(CANONICAL), `${JSON.stringify(v)} 哈希必须与规范形式一致`);
    }
  });

  test('redeemCodeHash 对结构不合法输入抛错（防绕过规范化直接哈希）', () => {
    assert.throws(() => redeemCodeHash('MIV-NOPE'), /格式不正确/);
  });
});

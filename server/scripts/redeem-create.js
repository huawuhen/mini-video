// 兑换码生成（M2-OPS-03 内测余额发放；API.md §3 兑换码的运营侧入口）：
//   npm run redeem:create -- <金额元> <张数> [有效天数]        # 本机
//   docker compose run --rm api node scripts/redeem-create.js <金额元> <张数> [有效天数]   # 生产容器
// 规则：码只在生成时打印一次（stdout），数据库只存 sha256 哈希（redeem_codes.code_hash）；
// 每批写一条管理审计（actor=redeem-create，detail 只含数量/金额/有效期，绝不含码本身）。
// 金额为整数元（内测面额 50/100/500），有效天数缺省 365。
import { createHash, randomInt } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/pool.js';
import { createLogger } from '../src/logger.js';

// Crockford base32（去 I L O U，避免手机上手抄/口误）
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 生成一个可人工抄写的码：MIV-XXXXX-XXXXX（10 字符 ≈ 50 bit 熵）。 */
export function newCode() {
  let body = '';
  for (let i = 0; i < 10; i += 1) body += ALPHABET[randomInt(ALPHABET.length)];
  return `MIV-${body.slice(0, 5)}-${body.slice(5)}`;
}

export const hashOf = (code) => createHash('sha256').update(code).digest('hex');

/**
 * 生成并落库 count 张兑换码；返回码列表（调用方负责只打印一次）。
 * 哈希主键冲突时自动重生成（概率极低，重试上限保护）。
 */
export async function createRedeemCodes(db, { amountFen, count, validDays = 365 }) {
  const expiresAt = new Date(Date.now() + validDays * 24 * 3600 * 1000);
  const codes = [];
  for (let i = 0; i < count; i += 1) {
    for (let attempt = 0; ; attempt += 1) {
      const code = newCode();
      try {
        await db.query(
          `INSERT INTO redeem_codes (code_hash, amount_fen, expires_at) VALUES ($1, $2, $3)`,
          [hashOf(code), amountFen, expiresAt],
        );
        codes.push(code);
        break;
      } catch (error) {
        if (error?.code === '23505' && attempt < 8) continue; // 哈希撞车：换一个码重试
        throw error;
      }
    }
  }
  await db.query(
    `INSERT INTO admin_audit_logs (actor, action, target_type, target_id, detail)
     VALUES ('redeem-create', 'redeem.create', 'redeem_code', 'batch', $1)`,
    [JSON.stringify({ count, amountFen, validDays, expiresAt: expiresAt.toISOString() })],
  );
  return codes;
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const [yuanArg, countArg, daysArg] = args;
  const yuan = Number(yuanArg);
  const count = Number(countArg ?? 1);
  const validDays = Number(daysArg ?? 365);
  if (!Number.isInteger(yuan) || yuan <= 0 || yuan > 10_000) {
    console.error('金额必须是 1~10000 的整数（元）'); process.exit(1);
  }
  if (!Number.isInteger(count) || count <= 0 || count > 500) {
    console.error('张数必须是 1~500 的整数'); process.exit(1);
  }
  if (!Number.isInteger(validDays) || validDays <= 0 || validDays > 3650) {
    console.error('有效天数必须是 1~3650 的整数'); process.exit(1);
  }
  const config = loadConfig();
  const logger = createLogger({ level: 'warn' });
  const db = createDb({ url: config.databaseUrl, max: 2, logger });
  try {
    const codes = await createRedeemCodes(db, { amountFen: yuan * 100, count, validDays });
    console.log(`已生成 ${count} 张兑换码（面额 ${yuan} 元，有效期 ${validDays} 天）。`);
    console.log('码只显示这一次（数据库只存哈希，无法找回），请立即抄录分发：');
    for (const code of codes) console.log(`  ${code}`);
  } finally {
    await db.close();
  }
}

// 直接运行时执行 CLI；被测试 import 时不执行
if (process.argv[1] && process.argv[1].endsWith('redeem-create.js')) {
  main().catch((error) => { console.error(`生成失败：${error.message}`); process.exit(1); });
}

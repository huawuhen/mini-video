// 短信验证码：发放（冷却 + 每日上限）、校验（错误次数上限）与登录注册。
// provider 可注入（docs/TASKS.md M1-BE-01）；console provider 把验证码打印到控制台，仅限开发/测试。
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { newId } from '../db/ids.js';
import { appError } from '../http/errors.js';
import { hitRateLimit } from './ratelimit.js';
import { sessionTokenHash } from './session.js';

export function maskPhone(phone) {
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

export function consoleSmsProvider(config) {
  const minutes = Math.max(1, Math.ceil(config.sms.codeTtlSeconds / 60));
  return {
    id: 'console',
    async send({ phone, code }) {
      // 任务要求开发环境打印验证码；用 console 而不是 logger，避免混入结构化日志
      // eslint-disable-next-line no-console
      console.log(`[sms:dev] ${maskPhone(phone)} 的验证码是 ${code}（开发环境模拟短信，${minutes} 分钟内有效）`);
    },
  };
}

const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');
// 哈希掺入手机号：验证码只有 10^6 种，不掺盐时一份库可离线碰撞所有手机号
const codeHash = (phone, code) => createHash('sha256').update(`${phone}:${code}`).digest('hex');

/** 发送验证码：每日上限走固定窗口限流，冷却在手机号级事务锁内检查。 */

export async function sendSmsCode({ db, config, logger, provider, phone }) {
  await hitRateLimit(db, {
    key: `sms:daily:${phone}`,
    windowSeconds: 86_400,
    max: config.sms.maxPerPhonePerDay,
    message: '今天发送的验证码次数已用完，请明天再试',
  });

  const code = newCode();
  const expiresAt = new Date(Date.now() + config.sms.codeTtlSeconds * 1000);
  // 审查意见 1：「冷却检查 → 作废旧码 → 插入新码」放进带手机号级事务锁的短事务，
  // 同手机号并发请求在此串行化，冷却不可被并发绕过；短信发送仍在事务外，不占数据库连接。
  const smsRowId = await db.tx(async (t) => {
    await t.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`sms:${phone}`]);
    if (config.sms.sendCooldownSeconds > 0) {
      const { rows } = await t.query(
        `SELECT created_at FROM sms_codes WHERE phone = $1 ORDER BY id DESC LIMIT 1`,
        [phone],
      );
      if (rows.length) {
        const elapsedSeconds = (Date.now() - rows[0].created_at.getTime()) / 1000;
        if (elapsedSeconds < config.sms.sendCooldownSeconds) {
          throw appError('SMS_COOLDOWN', undefined, { retryAfterSeconds: Math.ceil(config.sms.sendCooldownSeconds - elapsedSeconds) });
        }
      }
    }
    await t.query(`UPDATE sms_codes SET consumed_at = now() WHERE phone = $1 AND consumed_at IS NULL`, [phone]);
    const { rows } = await t.query(
      `INSERT INTO sms_codes (phone, code_hash, expires_at) VALUES ($1, $2, $3) RETURNING id`,
      [phone, codeHash(phone, code), expiresAt],
    );
    return rows[0].id;
  });

  try {
    await provider.send({ phone, code });
  } catch (err) {
    // 发送失败删除记录：不占冷却、不留死码
    await db.query(`DELETE FROM sms_codes WHERE id = $1 AND consumed_at IS NULL`, [smsRowId]);
    logger.error('sms_send_failed', { phone: maskPhone(phone), err });
    throw appError('UPSTREAM_FAILED', '验证码发送失败，请稍后再试');
  }
  logger.info('sms_code_sent', { phone: maskPhone(phone), provider: provider.id });
  return { cooldownSeconds: config.sms.sendCooldownSeconds };
}

/** 校验验证码并登录（不存在则注册）。无网络调用；成功路径短事务保证原子。 */
export async function loginWithSmsCode({ db, config, phone, code }) {
  const { rows } = await db.query(
    `SELECT id, code_hash, expires_at FROM sms_codes
     WHERE phone = $1 AND consumed_at IS NULL
     ORDER BY created_at DESC, id DESC LIMIT 1`,
    [phone],
  );
  const record = rows[0];
  if (!record) throw appError('SMS_CODE_INVALID');

  if (record.expires_at.getTime() <= Date.now()) {
    await db.query(`UPDATE sms_codes SET consumed_at = now() WHERE id = $1`, [record.id]);
    throw appError('SMS_CODE_INVALID');
  }

  // 审查意见 2：先原子占用一次尝试再比对哈希，并发提交读到旧值导致超发的问题由此消除；
  // 占用失败（无行）= 码已消费或错误次数已达上限。占用语句自带行锁，天然串行。
  const claim = await db.query(
    `UPDATE sms_codes SET attempts = attempts + 1
     WHERE id = $1 AND consumed_at IS NULL AND attempts < $2
     RETURNING id`,
    [record.id, config.sms.maxVerifyAttempts],
  );
  if (!claim.rows.length) throw appError('SMS_CODE_INVALID');

  if (codeHash(phone, code) !== record.code_hash) {
    // 错误：达上限即作废（attempts 已含本次占用的自增）
    await db.query(
      `UPDATE sms_codes SET consumed_at = CASE WHEN attempts >= $2 THEN now() ELSE consumed_at END WHERE id = $1`,
      [record.id, config.sms.maxVerifyAttempts],
    );
    throw appError('SMS_CODE_INVALID');
  }

  return db.tx(async (t) => {
    // 行锁后复核，防并发同码登录双消费
    const { rows } = await t.query(
      `SELECT id FROM sms_codes WHERE id = $1 AND consumed_at IS NULL FOR UPDATE`,
      [record.id],
    );
    if (!rows.length) throw appError('SMS_CODE_INVALID');
    await t.query(`UPDATE sms_codes SET consumed_at = now() WHERE id = $1`, [record.id]);

    let user = (await t.query(`SELECT * FROM users WHERE phone = $1`, [phone])).rows[0];
    let isNewUser = false;
    if (!user) {
      isNewUser = true;
      user = (await t.query(
        `INSERT INTO users (id, phone, nickname) VALUES ($1, $2, $3) RETURNING *`,
        [newId('usr'), phone, `用户${phone.slice(-4)}`],
      )).rows[0];
      // 钱包行随注册建好（余额 0），钱包模块无需懒建
      await t.query(`INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [user.id]);
    }
    if (user.status !== 'active') throw appError('UNAUTHENTICATED', '账号已被停用，请联系客服');

    const token = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + config.sessionTtlDays * 86_400_000);
    await t.query(
      `INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at) VALUES ($1, $2, $3, $4)`,
      [sessionTokenHash(token), user.id, csrfToken, expiresAt],
    );
    return { user, isNewUser, token, csrfToken };
  });
}

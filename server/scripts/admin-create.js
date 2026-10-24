// 管理员账号创建（API.md §8）：npm run admin:create [-- <用户名> <密码>] 或交互输入。
// 不开放注册；密码 scrypt 哈希入库。已有同名管理员时默认报错，--reset 改密码。
import { createInterface } from 'node:readline/promises';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/pool.js';
import { createLogger } from '../src/logger.js';
import { newId } from '../src/db/ids.js';
import { hashAdminPassword } from '../src/channels/crypto.js';

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const reset = args.includes('--reset');
const positional = args.filter((arg) => arg !== '--reset');
const [usernameArg, passwordArg] = positional;

async function main() {
  const config = loadConfig();
  const logger = createLogger({ level: 'warn' });
  const db = createDb({ url: config.databaseUrl, max: 2, logger });
  try {
    let username = usernameArg;
    let password = passwordArg;
    if (!username || !password) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      if (!username) username = (await rl.question('管理员用户名：')).trim();
      if (!password) {
        password = await rl.question('管理员密码（≥12 位，输入不回显请留意肩后）：');
        const repeat = await rl.question('再输一次确认：');
        if (password !== repeat) throw new Error('两次输入不一致');
      }
      rl.close();
    }
    if (!/^[a-zA-Z0-9_-]{3,32}$/.test(username)) throw new Error('用户名需 3~32 位字母/数字/_/-');
    const passwordHash = hashAdminPassword(password); // 校验长度并哈希
    const { rows: existing } = await db.query(
      `SELECT id FROM admin_users WHERE username = $1`, [username]);
    if (existing.length && !reset) throw new Error(`管理员已存在：${username}（改密码用 --reset）`);
    if (existing.length) {
      await db.query(`UPDATE admin_users SET password_hash = $2, updated_at = now() WHERE id = $1`,
        [existing[0].id, passwordHash]);
      console.log(`已重置管理员密码：${username}`);
    } else {
      const id = newId('adm');
      await db.query(
        `INSERT INTO admin_users (id, username, password_hash, display_name) VALUES ($1, $2, $3, $2)`,
        [id, username, passwordHash]);
      await db.query(
        `INSERT INTO admin_audit_logs (actor, action, target_type, target_id, detail)
         VALUES ('cli', 'admin.create', 'admin_user', $1, $2)`,
        [id, JSON.stringify({ username })]);
      console.log(`已创建管理员：${username}（id=${id}）`);
    }
  } finally {
    await db.close();
  }
}

main().catch((err) => { console.error(`创建失败：${err.message}`); process.exit(1); });

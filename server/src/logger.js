// JSON 行日志，自动脱敏（AGENTS.md §5）：手机号、验证码、Cookie、令牌、签名链接参数不入日志。

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const SECRET_KEYS = /^(password|code|smsCode|token|csrfToken|cookie|authorization|secret|secretKey|accessKey|apiKey|idempotencyKey)$/i;
const PHONE = /(?<!\d)(1[3-9]\d)\d{4}(\d{4})(?!\d)/g;
const SIGNED_QUERY = /([?&](?:e|token|sign|Signature|X-Amz-Signature)=)[^&\s"]+/g;

function scrub(value, depth = 0) {
  if (depth > 6) return '[depth]';
  if (typeof value === 'string') return value.replace(PHONE, '$1****$2').replace(SIGNED_QUERY, '$1***');
  if (value instanceof Error) return { name: value.name, message: scrub(value.message, depth + 1), code: value.code, stack: value.stack };
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEYS.test(k) ? '***' : scrub(v, depth + 1);
    return out;
  }
  return value;
}

export function createLogger({ level = 'info', base = {}, write = (line) => process.stdout.write(`${line}\n`) } = {}) {
  const min = LEVELS[level] ?? LEVELS.info;
  const log = (lvl, msg, fields) => {
    if (LEVELS[lvl] < min) return;
    write(JSON.stringify({ time: new Date().toISOString(), level: lvl, msg, ...scrub({ ...base, ...fields }) }));
  };
  return {
    debug: (msg, fields) => log('debug', msg, fields),
    info: (msg, fields) => log('info', msg, fields),
    warn: (msg, fields) => log('warn', msg, fields),
    error: (msg, fields) => log('error', msg, fields),
    child: (fields) => createLogger({ level, base: { ...base, ...fields }, write }),
  };
}

export const silentLogger = createLogger({ level: 'silent' });

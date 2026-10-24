// 驱动契约（docs/ARCHITECTURE.md §5.5）——驱动与业务层之间唯一的公共约定。
// 驱动 = 一种上游协议（drivers/<协议>/ 一个目录）；渠道 = 一条数据库记录（provider_channels）。
// 硬性约束：不引入厂商 SDK（一律走共用 HTTP 层）；厂商差异（参数名/状态码/错误码/鉴权）只留在驱动内；
//   业务层出现厂商名或厂商错误码即缺陷；能力用声明表达，业务代码不写 if (厂商 === ...)。

/**
 * 统一错误：资金与重试决策只看 submitted / retryable / code，不看原始文本。
 * - submitted: true（请求已发出）| false（确定没发出）| 缺省（不确定）——关键字段。
 *   「已发出/不确定」绝不重试提交；只有 false 且 retryable 才允许交队列重试。
 * - retryable: 队列层是否可重试（连接失败、429 等「确定未提交」类）。
 * - providerMessage / providerCode: 上游原始信息（截断 200 字符），只进日志与「技术详情」，不展示给用户。
 * code 取值（沿用 M1-ENG-02 评审口径，对应 ARCHITECTURE §5.5 的分类意图）：
 *   AUTH→PROVIDER_REJECTED(401/403)、RATE_LIMITED→PROVIDER_RATE_LIMITED、UNAVAILABLE→PROVIDER_NOT_SUBMITTED、
 *   BAD_REQUEST→PROVIDER_INPUT_INVALID / PROVIDER_CONFIG_INVALID、CONTENT_BLOCKED→PROVIDER_REFERENCE_REJECTED、
 *   UPSTREAM_FAILED→PROVIDER_FAILED、TIMEOUT/UNKNOWN→SUBMISSION_UNKNOWN / PROVIDER_QUERY_FAILED、
 *   其他→PROVIDER_REFERENCE_UNAVAILABLE（参考素材读取）。
 */
export class ProviderError extends Error {
  constructor(message, { code = 'PROVIDER_FAILED', submitted, retryable = false, status, providerMessage, providerCode, retryAfter } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.retryable = retryable;
    if (submitted !== undefined) this.submitted = submitted;
    if (status !== undefined) this.status = status;
    if (providerMessage !== undefined) this.providerMessage = providerMessage;
    if (providerCode !== undefined) this.providerCode = providerCode;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}

export const CHANNEL_KINDS = Object.freeze(['video', 'image', 'llm']);

/**
 * 驱动模块默认导出的固定形状：
 * {
 *   id: 'aiide-ark',                    // 必须等于目录名
 *   kinds: ['video'],                   // 该协议能承载的能力种类（video|image|llm）
 *   configSchema: {                     // 后台表单与校验的唯一来源
 *     baseUrl: 'url', credential: 'secret', modelMap: 'models',
 *     params: { requestTimeoutMs: 'int', … },   // 可选项及类型，默认值见驱动 README
 *   },
 *   create(channel, ctx) → 驱动实例      // channel: { id, kind, name, baseUrl, credential, modelMap, params }
 *                                      // ctx: { logger, deps: { fetchImpl?, loadReference?, downloadImage?, sleep? } }
 * }
 *
 * 驱动实例按 kind 的最小接口（业务层依赖的形状，M1-ENG-02 / BE-04 评审口径不变）：
 * - video: { id, capabilities(), prepare(input, sku), submit(prepared, { idempotencyKey }), query(upstreamId), normalize(raw), catalog?() }
 * - image: { id, capabilities(), generate({ characterId, styleId, promptHint, description, referenceKeys, sku }), catalog?() }
 * - llm:   { id, capabilities(), complete({ system, messages, signal }) → { text, usage }, catalog?() }
 * capabilities()（能力声明，业务层据此约束输入，不写厂商分支）：
 * - video: { durations: number[], resolutions: string[], ratios: string[], refImages: number, refAudio: number, withAudio: boolean, model: string }
 * - image: { resolutions: string[], ratios: string[], refImages: number, model: string }
 * - llm:   { model: string, contextTokens?: number }
 */

const INSTANCE_REQUIRED = Object.freeze({
  video: ['id', 'capabilities', 'prepare', 'submit', 'query', 'normalize'],
  image: ['id', 'capabilities', 'generate'],
  llm: ['id', 'capabilities', 'complete'],
});

/** 校验驱动模块导出形状；不合法直接抛（编程错误，启动即失败）。 */
export function assertDriverExport(driver, dirName) {
  const where = `驱动 drivers/${dirName ?? '?'}`;
  if (!driver || typeof driver !== 'object') throw new Error(`${where} 缺少 default 导出对象`);
  if (typeof driver.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(driver.id)) {
    throw new Error(`${where}.id 必须是 kebab-case 字符串`);
  }
  if (dirName && driver.id !== dirName) throw new Error(`${where}.id（${driver.id}）必须等于目录名`);
  if (!Array.isArray(driver.kinds) || !driver.kinds.length
    || driver.kinds.some((kind) => !CHANNEL_KINDS.includes(kind))) {
    throw new Error(`${where}.kinds 必须是 ${CHANNEL_KINDS.join('/')} 的非空子集`);
  }
  if (!driver.configSchema || typeof driver.configSchema !== 'object') {
    throw new Error(`${where}.configSchema 必须是对象`);
  }
  if (typeof driver.create !== 'function') throw new Error(`${where}.create 必须是函数`);
  return true;
}

/** 校验 create() 返回的实例形状（按渠道的 kind）。 */
export function assertDriverInstance(instance, { id, kind }) {
  const required = INSTANCE_REQUIRED[kind];
  if (!required) throw new ProviderError(`渠道能力种类不合法：${kind}`, { code: 'PROVIDER_CONFIG_INVALID', submitted: false });
  if (!instance || typeof instance !== 'object') {
    throw new ProviderError('驱动实例创建失败。', { code: 'PROVIDER_CONFIG_INVALID', submitted: false });
  }
  for (const member of required) {
    if (typeof instance[member] !== 'function' && member !== 'id') {
      throw new ProviderError(`驱动实例缺少 ${member}。`, { code: 'PROVIDER_CONFIG_INVALID', submitted: false });
    }
  }
  if (typeof instance.id !== 'string' || !instance.id) {
    throw new ProviderError('驱动实例缺少 id。', { code: 'PROVIDER_CONFIG_INVALID', submitted: false });
  }
  if (typeof instance.capabilities !== 'function') {
    throw new ProviderError('驱动实例缺少 capabilities()。', { code: 'PROVIDER_CONFIG_INVALID', submitted: false });
  }
  const caps = instance.capabilities();
  if (!caps || typeof caps !== 'object' || typeof caps.model !== 'string' || !caps.model) {
    throw new ProviderError('capabilities() 必须声明 model。', { code: 'PROVIDER_CONFIG_INVALID', submitted: false });
  }
  return instance;
}

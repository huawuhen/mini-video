// 契约测试套件（docs/ARCHITECTURE.md §5.5 驱动规范 5）：每个驱动必须通过同一套契约测试，
// 用录制/构造的样本回放（零真实费用）。各驱动目录的 driver.test.js 调用这里的 run*Contract，
// 只需提供自己的夹具（fixtures/，来源在 fixtures/provenance.md 注明）与驱动实例构造函数。
// 断言的是「行为契约」而非协议细节：提交成功/明确拒绝/连接失败/超时的分类、轮询终态、
// 能力声明形状、结果与错误不泄漏明文凭证。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderError } from './contract.js';

/**
 * 样本回放假 fetch：按 steps 顺序匹配（url 含 match 字符串且 method 相符）消费一次。
 * step: { match: string, method?: string, status?: number, json?: object, text?: string,
 *         hang?: boolean（不响应，配合短超时测超时）, error?: { code }（网络层错误） }
 * 未匹配的请求立即抛错（意外调用必须暴露）。记录每次调用供断言（含 Authorization 是否携带）。
 */
export function createScriptedFetch(steps) {
  const remaining = [...steps];
  const calls = [];
  const fetchImpl = (url, init = {}) => new Promise((resolve, reject) => {
    const method = String(init.method ?? 'GET').toUpperCase();
    const href = String(url);
    // 必须响应调用方的 AbortSignal（超时/取消要生效，否则 hang 场景会永久挂起）
    const onAbort = () => {
      const error = new Error('scripted fetch aborted');
      error.name = 'AbortError';
      reject(error);
    };
    if (init.signal) {
      if (init.signal.aborted) return onAbort();
      init.signal.addEventListener('abort', onAbort, { once: true });
    }
    const settle = (fn, value) => {
      init.signal?.removeEventListener?.('abort', onAbort);
      fn(value);
    };
    (async () => {
      const index = remaining.findIndex((step) => href.includes(step.match)
        && (!step.method || step.method.toUpperCase() === method));
      calls.push({ url: href, method, hasAuth: /Bearer .+/.test(String(init.headers?.Authorization ?? '')),
        body: typeof init.body === 'string' ? init.body : undefined, form: init.body instanceof FormData });
      if (index < 0) throw new Error(`scripted_fetch_unexpected: ${method} ${href}`);
      const step = remaining.splice(index, 1)[0];
      if (step.hang) await new Promise(() => {}); // 永不返回，由 abort 兜底触发调用方超时
      if (step.error) {
        const error = new Error(`scripted network failure: ${step.error.code}`);
        error.code = step.error.code;
        throw error;
      }
      const status = step.status ?? 200;
      const text = step.json !== undefined ? JSON.stringify(step.json) : step.text ?? '';
      return {
        status,
        ok: status >= 200 && status < 300,
        headers: { get: () => null },
        text: async () => text,
      };
    })().then((value) => settle(resolve, value), (error) => settle(reject, error));
  });
  return { fetchImpl, calls, get remaining() { return remaining.length; } };
}

/** 契约通用的最小渠道记录（测试里按驱动覆盖 driver/kind/modelMap）。 */
export const CONTRACT_CREDENTIAL = 'sk-contract-test-secret-000000';

export function contractChannel(overrides = {}) {
  return {
    id: 'pch_contract00000',
    kind: 'video',
    name: 'contract-fixture',
    driver: 'unset',
    baseUrl: 'https://channel.example.test',
    credential: CONTRACT_CREDENTIAL,
    modelMap: {},
    params: {},
    ...overrides,
  };
}

/** 场景夹具归一为回放步骤：单响应对象 → 一个 200 步骤；数组 → 原样（多步序列，如提交→轮询→轮询）。 */
const asSteps = (fixture) => (Array.isArray(fixture)
  ? fixture
  : [{ match: '', status: 200, json: fixture }]);

const assertNoCredentialLeak = (value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value, (_k, v) => (v instanceof Buffer ? '<buffer>' : v));
  assert.ok(!text.includes(CONTRACT_CREDENTIAL), `结果/错误泄漏了明文凭证：${text.slice(0, 200)}`);
};

/** 驱动抛出的错误是否「结果不确定」（提交已发出或无法判定）：不得被当成可安全重试。 */
const isUncertainSubmission = (error) => error instanceof ProviderError
  && error.submitted !== false && error.retryable !== true;

/**
 * 超时场景的统一断言：生成请求本身超时 → 「结果不确定」（unknown 或 submitted!==false 且非 retryable 的抛错，
 * 绝不 failed、绝不自动重提）；若驱动存在**计费提交之前**的预检阶段（如素材过审），超时判
 * submitted=false + retryable（安全重试）同样符合契约。
 */
function assertTimeoutOutcome(outcome, phase) {
  if (outcome.error) {
    const { code, submitted, retryable } = outcome.error;
    const uncertain = outcome.error instanceof ProviderError && submitted !== false && retryable !== true;
    const safeRetry = outcome.error instanceof ProviderError && submitted === false && retryable === true;
    assert.ok(uncertain || safeRetry,
      `${phase}超时应判「结果不确定」或「未提交可安全重试」，实际 ${JSON.stringify({ code, submitted, retryable })}`);
  } else {
    assert.equal(outcome.result.status, 'unknown');
  }
}

const sampleVideoInput = () => ({
  prompt: 'A girl waves at the camera, gentle smile.',
  imageRefs: ['https://cdn.example.test/looks/lkv_1.png'],
  audioRefs: [],
  durationSeconds: 5,
  ratio: '9:16',
  resolution: '480p',
});

const sampleImageInput = () => ({
  characterId: 'chr_1',
  styleId: 'style_cute',
  promptHint: 'cute 3d style',
  description: 'a young mother',
  referenceKeys: ['users/u1/uploads/upl_1'],
});

/**
 * 视频驱动契约。build({ fetchImpl, logger, deps }) → 驱动实例（fresh per 场景）；
 * fixtures = { submitAccepted, submitRejected, queryRunning, querySucceeded, queryFailed }（各驱动的录制样本）。
 */
export function runVideoDriverContract({ title, build, fixtures, videoInput = sampleVideoInput(), sku = {} }) {
  const make = (steps) => {
    const scripted = createScriptedFetch(steps);
    const instance = build({ fetchImpl: scripted.fetchImpl, logger: consoleCapture() });
    return { scripted, instance };
  };

  test(`${title}：提交成功 → running + upstreamId`, async () => {
    const { instance, scripted } = make(asSteps(fixtures.submitAccepted));
    const result = await instance.submit(instance.prepare(videoInput, sku), {});
    assert.equal(result.status, 'running');
    assert.ok(typeof result.upstreamId === 'string' && result.upstreamId);
    assert.equal(scripted.remaining, 0);
    assert.ok(scripted.calls.every((call) => call.hasAuth), '请求必须携带鉴权头');
  });

  test(`${title}：提交明确拒绝 → { status:'failed' }（中文提示，不冻结不重试）`, async () => {
    const { instance } = make([{ match: '', status: 400, json: fixtures.submitRejected }]);
    const result = await instance.submit(instance.prepare(videoInput, sku), {});
    assert.equal(result.status, 'failed');
    assert.ok(typeof result.error === 'string' && result.error);
    assertNoCredentialLeak(result);
  });

  test(`${title}：提交连接失败 → 抛 submitted=false 可重试`, async () => {
    const { instance } = make([{ match: '', error: { code: 'ECONNREFUSED' } }]);
    await assert.rejects(instance.submit(instance.prepare(videoInput, sku), {}), (error) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.submitted, false);
      assert.equal(error.retryable, true);
      return true;
    });
  });

  test(`${title}：提交超时/断连 → 结果不确定（绝不 failed、绝不自动重提）`, async () => {
    const { instance } = make([{ match: '', hang: true }]);
    const prepared = instance.prepare(videoInput, sku);
    const outcome = await instance.submit(prepared, {}).then(
      (result) => ({ result }),
      (error) => ({ error }),
    );
    assertTimeoutOutcome(outcome, '提交');
  });

  test(`${title}：查询进行中 → running`, async () => {
    const { instance } = make(asSteps(fixtures.queryRunning));
    assert.equal((await instance.query('task_1')).status, 'running');
  });

  test(`${title}：查询成功 → outputs 含 http(s) 视频地址`, async () => {
    const { instance } = make(asSteps(fixtures.querySucceeded));
    const result = await instance.query('task_1');
    assert.equal(result.status, 'succeeded');
    const output = (result.outputs ?? []).find((item) => item.kind === 'video');
    assert.ok(output && /^https?:\/\//.test(output.url), 'outputs 必须含 http(s) 视频地址');
    assertNoCredentialLeak(result);
  });

  test(`${title}：查询失败 → failed + 中文提示`, async () => {
    const { instance } = make(asSteps(fixtures.queryFailed));
    const result = await instance.query('task_1');
    assert.equal(result.status, 'failed');
    assert.ok(typeof result.error === 'string' && result.error);
    assertNoCredentialLeak(result);
  });

  test(`${title}：查询网络失败 → 抛可重试（任务在渠道侧，继续轮询不冻结）`, async () => {
    const { instance } = make([{ match: '', error: { code: 'ECONNRESET' } }]);
    await assert.rejects(instance.query('task_1'), (error) => error instanceof ProviderError && error.retryable === true);
  });

  test(`${title}：能力声明与 normalize`, () => {
    const { instance } = make([]);
    const caps = instance.capabilities();
    assert.equal(typeof caps.model, 'string');
    assert.ok(Array.isArray(caps.resolutions) && caps.resolutions.length);
    assert.ok(Array.isArray(caps.durations) && caps.durations.length);
    assert.equal(typeof caps.withAudio, 'boolean');
    assert.equal(typeof caps.refImages, 'number');
    assert.equal(typeof caps.refAudio, 'number');
    const normalized = instance.normalize({ any: 'raw' });
    assert.equal(typeof normalized, 'object');
  });

  test(`${title}：实例与能力声明不携带明文凭证`, () => {
    const { instance } = make([]);
    assertNoCredentialLeak(instance);
    assertNoCredentialLeak(instance.capabilities());
  });
}

/** 图片驱动契约。build 同上；fixtures = { generateAccepted, generateRejected }。 */
export function runImageDriverContract({ title, build, imageInput = sampleImageInput(), fixtures }) {
  const make = (steps, deps = {}) => {
    const scripted = createScriptedFetch(steps);
    const instance = build({ fetchImpl: scripted.fetchImpl, logger: consoleCapture(), deps });
    return { scripted, instance };
  };

  test(`${title}：生成成功 → succeeded + Buffer + contentType`, async () => {
    const { instance } = make(asSteps(fixtures.generateAccepted));
    const result = await instance.generate(imageInput);
    assert.equal(result.status, 'succeeded');
    assert.ok(Buffer.isBuffer(result.buffer) && result.buffer.length > 0);
    assert.ok(typeof result.contentType === 'string' && result.contentType.startsWith('image/'));
    assertNoCredentialLeak(result);
  });

  test(`${title}：明确拒绝 → { status:'failed' }（中文提示）`, async () => {
    const { instance } = make([{ match: '', status: 400, json: fixtures.generateRejected }]);
    const result = await instance.generate(imageInput);
    assert.equal(result.status, 'failed');
    assert.ok(typeof result.error === 'string' && result.error);
    assertNoCredentialLeak(result);
  });

  test(`${title}：连接失败 → 抛 submitted=false 可重试（发生在计费生成之前）`, async () => {
    const { instance } = make([{ match: '', error: { code: 'ECONNREFUSED' } }]);
    await assert.rejects(instance.generate(imageInput), (error) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.submitted, false);
      assert.equal(error.retryable, true);
      return true;
    });
  });

  test(`${title}：超时/断连 → unknown 或「结果不确定」（冻结待对账，不自动重提）`, async () => {
    const { instance } = make([{ match: '', hang: true }]);
    const outcome = await instance.generate(imageInput).then((result) => ({ result }), (error) => ({ error }));
    assertTimeoutOutcome(outcome, '生成');
  });

  test(`${title}：能力声明形状`, () => {
    const { instance } = make([]);
    const caps = instance.capabilities();
    assert.equal(typeof caps.model, 'string');
    assert.ok(Array.isArray(caps.resolutions) && caps.resolutions.length);
    assert.equal(typeof caps.refImages, 'number');
    assertNoCredentialLeak(caps);
  });
}

/** LLM 驱动契约。fixtures = { completeAccepted }。 */
export function runLlmDriverContract({ title, build, fixtures }) {
  test(`${title}：补全成功 → { text, usage }`, async () => {
    const scripted = createScriptedFetch([{ match: '', method: 'POST', status: 200, json: fixtures.completeAccepted }]);
    const instance = build({ fetchImpl: scripted.fetchImpl, logger: consoleCapture() });
    const result = await instance.complete({ system: 'You are helpful.', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(typeof result.text, 'string');
    assert.ok(result.text);
    assert.ok(result.usage && typeof result.usage === 'object');
  });

  test(`${title}：上游 HTTP 错误 → 抛错（不静默返回空文本）`, async () => {
    const scripted = createScriptedFetch([{ match: '', method: 'POST', status: 500, json: { error: { message: 'boom' } } }]);
    const instance = build({ fetchImpl: scripted.fetchImpl, logger: consoleCapture() });
    await assert.rejects(instance.complete({ system: '', messages: [{ role: 'user', content: 'hi' }] }));
  });

  test(`${title}：调用前已取消 → 直接抛出且零请求`, async () => {
    const scripted = createScriptedFetch([]);
    const instance = build({ fetchImpl: scripted.fetchImpl, logger: consoleCapture() });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(instance.complete({ system: '', messages: [{ role: 'user', content: 'hi' }], signal: controller.signal }));
    assert.equal(scripted.calls.length, 0);
  });

  test(`${title}：能力声明与凭证不泄漏`, () => {
    const instance = build({ fetchImpl: createScriptedFetch([]).fetchImpl, logger: consoleCapture() });
    const caps = instance.capabilities();
    assert.equal(typeof caps.model, 'string');
    assertNoCredentialLeak(caps);
    assertNoCredentialLeak(instance);
  });
}

/** 捕获日志的最小 logger（契约测试断言日志不泄漏凭证时可复用）。 */
export function consoleCapture() {
  const entries = [];
  const capture = (level) => (event, fields) => entries.push({ level, event, fields });
  return {
    debug: capture('debug'), info: capture('info'), warn: capture('warn'), error: capture('error'),
    entries,
    assertNoCredential() { assertNoCredentialLeak(entries); },
  };
}

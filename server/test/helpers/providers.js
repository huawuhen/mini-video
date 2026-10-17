// 测试用模拟图片模型 provider（接口与 worker.js createDevImageProvider 一致；ENG-02 完成后由 engine/providers 替代）。
export const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

/**
 * @param {object} [opts]
 * @param {'succeeded' | 'failed' | 'unknown'} [opts.result]  每次调用的返回状态
 * @param {number} [opts.failAfter]  前 N 次返回 opts.result，之后返回 succeeded（模拟重试后恢复）
 */
export function mockImageProvider({ result = 'succeeded', failAfter } = {}) {
  const provider = {
    calls: [],
    id: 'mock-image',
    async generate(input) {
      provider.calls.push(input);
      const nth = provider.calls.length;
      const status = failAfter === undefined || nth <= failAfter ? result : 'succeeded';
      if (status === 'unknown') return { status: 'unknown' };
      if (status === 'failed') return { status: 'failed', error: '模拟模型拒绝' };
      return { status: 'succeeded', buffer: TINY_PNG, contentType: 'image/png' };
    },
  };
  return provider;
}

// openai-compatible 驱动——OpenAI Chat Completions 文本 LLM 协议（智谱中国区 API，
// 用户 2026-10-21 选型；M2-BE-03 由 M2-BE-01 的 engine/llm/openai.js 平移为驱动）。
// 直接实现 engine 的 llm.complete 最小接口（{ system, messages, signal } → { text, usage }），
// 供 createStoryAgent 注入；非流式、单次补全，重试与兜底由 story agent 的修复循环负责。
// LLM 渠道默认不动（用户 2026-10-24）：路由层对 llm 只在「无生效渠道」时报错，不参与视频/图片式切换运营。
import { ProviderError } from '../../contract.js';
import { createChannelHttp } from '../../transport.js';

export const DEFAULT_PARAMS = Object.freeze({
  timeoutMs: 90_000,
});

export default {
  id: 'openai-compatible',
  kinds: ['llm'],
  configSchema: {
    baseUrl: 'url',           // 如 https://open.bigmodel.cn/api/paas/v4
    credential: 'secret',
    modelMap: 'models',       // { "llm": "glm-4.6" }
    params: { timeoutMs: 'int（单次补全超时，缺省 90000）' },
  },

  /** @param ctx.deps { fetchImpl } */
  create(channel, { logger, deps = {} } = {}) {
    const params = { ...DEFAULT_PARAMS, ...(channel.params ?? {}) };
    const model = channel.modelMap?.llm ?? channel.params?.model;
    if (!model) {
      throw new ProviderError('LLM 渠道缺少模型配置（model_map.llm）。', { code: 'PROVIDER_CONFIG_INVALID', submitted: false });
    }
    const http = createChannelHttp({
      baseUrl: channel.baseUrl, credential: channel.credential,
      timeoutMs: params.timeoutMs, fetchImpl: deps.fetchImpl,
    });

    return {
      id: `openai-compatible/${model}`,
      kind: 'llm',

      capabilities() {
        return { model };
      },

      async complete({ system, messages, signal }) {
        if (signal?.aborted) {
          const error = new Error('LLM 调用已取消');
          error.name = 'AbortError';
          throw error;
        }
        const startedAt = Date.now();
        const { ok, status, data } = await http.request('chat/completions', {
          method: 'POST',
          body: {
            model,
            messages: [
              ...(system ? [{ role: 'system', content: system }] : []),
              ...messages.map((message) => ({ role: message.role ?? 'user',
                content: Array.isArray(message.content)
                  ? message.content.map((block) => block.text ?? '').join('') : String(message.content ?? '') })),
            ],
            stream: false,
          },
        });
        if (signal?.aborted) {
          const error = new Error('LLM 调用已取消');
          error.name = 'AbortError';
          throw error;
        }
        if (!ok) {
          logger?.warn?.('llm_http_error', { status, detail: data?.error?.message ?? null });
          throw new Error(`LLM 渠道返回 ${status}`);
        }
        const text = data?.choices?.[0]?.message?.content ?? '';
        if (!text) throw new Error('LLM 没有返回有效内容');
        const usage = data.usage ?? {};
        logger?.info?.('llm_completed', { model, inputTokens: usage.prompt_tokens ?? 0,
          outputTokens: usage.completion_tokens ?? 0, ms: Date.now() - startedAt });
        return { text, usage: { inputTokens: usage.prompt_tokens ?? 0, outputTokens: usage.completion_tokens ?? 0 } };
      },

      /** 免费模型目录（channel:test 用）：GET {base}/models（OpenAI 兼容基址已含版本段，用相对路径）。 */
      async catalog() {
        const { ok, status, data } = await http.request('models');
        if (!ok || !Array.isArray(data?.data)) {
          throw new ProviderError(`模型目录不可用（HTTP ${status ?? 'ERR'}）。`, {
            code: 'PROVIDER_QUERY_FAILED', submitted: false,
          });
        }
        return { models: data.data.map((item) => ({ name: String(item.id ?? '') })).filter((m) => m.name) };
      },
    };
  },
};

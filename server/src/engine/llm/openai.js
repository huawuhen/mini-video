// OpenAI Compatible 文本 LLM（M2-BE-01，用户 2026-10-21 选型：智谱中国区 Coding Plan）。
// 直接实现 engine 的 llm.complete 最小接口（{ system, messages, signal } → { text, usage }），
// 供 createStoryAgent 注入；非流式、单次补全，重试与兜底由 story agent 的修复循环负责。
// 密钥只从注入的 config 来（服务端 env），本模块不读 process.env；测试注入假 fetch。
const DEFAULT_TIMEOUT_MS = 90_000;

export function createOpenAiCompatLlm({ baseUrl, apiKey, model, timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch, logger } = {}) {
  if (!baseUrl || !apiKey || !model) throw new TypeError('需要注入 baseUrl / apiKey / model');
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  return {
    id: `openai-compat:${model}`,
    async complete({ system, messages, signal }) {
      if (signal?.aborted) {
        const error = new Error('LLM 调用已取消');
        error.name = 'AbortError';
        throw error;
      }
      const deadline = AbortSignal.timeout(timeoutMs); // Node ≥22：单次调用超时
      const merged = signal ? AbortSignal.any([signal, deadline]) : deadline;
      const startedAt = Date.now();
      let response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          signal: merged,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model,
            messages: [
              ...(system ? [{ role: 'system', content: system }] : []),
              ...messages.map((message) => ({ role: message.role ?? 'user',
                content: Array.isArray(message.content)
                  ? message.content.map((block) => block.text ?? '').join('') : String(message.content ?? '') })),
            ],
            stream: false,
          }),
        });
      } catch (error) {
        if (signal?.aborted) {
          const abortError = new Error('LLM 调用已取消');
          abortError.name = 'AbortError';
          throw abortError;
        }
        throw error; // 网络类失败：交给 story agent 的修复重试 / 兜底
      }
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        logger?.warn?.('llm_http_error', { status: response.status, body: body.slice(0, 200) });
        const error = new Error(`LLM 渠道返回 ${response.status}`);
        error.status = response.status;
        throw error;
      }
      const data = await response.json();
      const text = data.choices?.[0]?.message?.content ?? '';
      if (!text) throw new Error('LLM 没有返回有效内容');
      const usage = data.usage ?? {};
      logger?.info?.('llm_completed', { model, inputTokens: usage.prompt_tokens ?? 0,
        outputTokens: usage.completion_tokens ?? 0, ms: Date.now() - startedAt });
      return { text, usage: { inputTokens: usage.prompt_tokens ?? 0, outputTokens: usage.completion_tokens ?? 0 } };
    },
  };
}

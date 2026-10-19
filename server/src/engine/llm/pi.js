// Source: chaodayun@2926b42 backend/agent/{index,llm}.js.
// Pi Agent bridge without source repository, session, billing, environment, or provider coupling.
import { Agent } from '@earendil-works/pi-agent-core';

export function createPiLlm({ model, streamFn }) {
  if (!model || typeof streamFn !== 'function') throw new TypeError('需要注入 pi model 与 streamFn');
  return {
    async complete({ system, messages, signal }) {
      const agent = new Agent({ initialState: { systemPrompt: system, model, tools: [] }, streamFn });
      // Replay earlier messages with their own roles so repair turns include the failed assistant output.
      const history = messages.slice(0, -1).map((message) => ({ role: message.role === 'assistant' ? 'assistant' : 'user',
        content: String(message.content ?? ''), timestamp: Date.now() }));
      if (history.length) agent.state.messages = [...agent.state.messages, ...history];
      const abort = () => agent.abort();
      signal?.addEventListener('abort', abort, { once: true });
      try {
        if (signal?.aborted) {
          const error = new Error('LLM 调用已取消');
          error.name = 'AbortError';
          throw error;
        }
        const current = messages.at(-1);
        if (!current) throw new Error('LLM 调用缺少用户消息');
        await agent.prompt(String(current.content ?? ''));
        const assistants = agent.state.messages.filter((message) => message.role === 'assistant');
        const latest = assistants.at(-1);
        if (!latest || latest.stopReason === 'error' || latest.stopReason === 'aborted') {
          throw new Error(latest?.errorMessage ?? 'LLM 没有返回有效内容');
        }
        return { text: latest.content.filter((block) => block.type === 'text').map((block) => block.text).join(''),
          usage: assistants.reduce((sum, message) => ({ inputTokens: sum.inputTokens + (message.usage?.input ?? 0),
            outputTokens: sum.outputTokens + (message.usage?.output ?? 0) }), { inputTokens: 0, outputTokens: 0 }) };
      } finally { signal?.removeEventListener('abort', abort); }
    },
  };
}

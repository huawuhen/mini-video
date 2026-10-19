// Scripted LLM for deterministic story-agent tests; never contacts a model provider.
export function createMockLlm(script) {
  const steps = [...script];
  const calls = [];
  return {
    calls,
    async complete(request) {
      calls.push(request);
      if (!steps.length) throw new Error('模拟 LLM 响应已用完');
      const step = steps.shift();
      if (step instanceof Error) throw step;
      if (typeof step === 'function') {
        // Hang until the caller aborts, mirroring a provider that ignores deadlines.
        return new Promise((resolve, reject) => {
          const onAbort = () => {
            const reason = request.signal?.reason ?? new Error('LLM 调用已取消');
            reject(reason instanceof Error ? reason : new Error(String(reason)));
          };
          if (request.signal?.aborted) onAbort();
          else request.signal?.addEventListener('abort', onAbort, { once: true });
        });
      }
      return typeof step === 'string' ? { text: step, usage: { inputTokens: 0, outputTokens: 0 } } : step;
    },
  };
}

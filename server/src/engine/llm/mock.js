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
      return typeof step === 'string' ? { text: step, usage: { inputTokens: 0, outputTokens: 0 } } : step;
    },
  };
}

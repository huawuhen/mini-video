import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { createPiLlm } from '../../src/engine/llm/pi.js';

const model = { id: 'mock', name: 'mock', api: 'openai-completions', provider: 'mock', baseUrl: '', reasoning: false,
  input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 512 };
const usage = { input: 12, output: 8, cacheRead: 0, cacheWrite: 0, totalTokens: 20,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

describe('engine/llm pi bridge', () => {
  test('pi Agent 使用注入的模拟流，修复上下文可见并汇总 token', async () => {
    const seen = [];
    const streamFn = (_model, context) => {
      seen.push(context.messages);
      const stream = createAssistantMessageEventStream();
      const message = { role: 'assistant', content: [{ type: 'text', text: '{"ok":true}' }],
        api: 'openai-completions', provider: 'mock', model: 'mock', usage, stopReason: 'stop', timestamp: Date.now() };
      stream.push({ type: 'start', partial: message });
      stream.push({ type: 'done', reason: 'stop', message });
      return stream;
    };
    const response = await createPiLlm({ model, streamFn }).complete({ system: '安全提示', messages: [
      { role: 'user', content: '原始故事' }, { role: 'user', content: '校验错误：缺少 synopsis' },
    ] });
    assert.deepEqual(response, { text: '{"ok":true}', usage: { inputTokens: 12, outputTokens: 8 } });
    assert.ok(JSON.stringify(seen[0]).includes('原始故事'));
    assert.ok(JSON.stringify(seen[0]).includes('校验错误'));
  });
});

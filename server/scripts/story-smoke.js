// Real-provider smoke script for M0/M2, run manually with explicit authorization.
// Not used by npm test or review; reads model configuration from the environment and never ships keys.
// Usage: node server/scripts/story-smoke.js "一句话故事"
const [, , storyText = '妈妈带宝宝在公园野餐，宝宝追着蝴蝶跑。'] = process.argv;
const baseUrl = process.env.STORY_LLM_BASE_URL;
const apiKey = process.env.STORY_LLM_API_KEY;
const modelId = process.env.STORY_LLM_MODEL;

if (!baseUrl || !apiKey || !modelId) {
  console.error('缺少 STORY_LLM_BASE_URL / STORY_LLM_API_KEY / STORY_LLM_MODEL 环境变量；真实调用需要用户授权（AGENTS.md §6）。');
  process.exit(1);
}

const { createPiLlm } = await import('../src/engine/llm/pi.js');
const { createStoryAgent } = await import('../src/engine/story/index.js');
const { createAgentLlm } = await import('/root/chaodayun/backend/agent/llm.js').catch(() => ({}));

let llm;
if (typeof createAgentLlm === 'function') {
  // Authorized environments may reuse the chaodayun OpenAI-compatible provider adapter.
  const provider = createAgentLlm({ baseUrl, apiKey, model: modelId, apiKind: 'chat-completions' });
  llm = createPiLlm({ model: provider.model, streamFn: provider.models.streamSimple.bind(provider.models) });
} else {
  const { Agent } = await import('@earendil-works/pi-agent-core');
  const { createAssistantMessageEventStream } = await import('@earendil-works/pi-ai');
  const model = { id: modelId, name: modelId, api: 'openai-completions', provider: 'story-smoke', baseUrl,
    reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 0, maxTokens: 0 };
  llm = createPiLlm({ model, streamFn: async (_model, context) => {
    const stream = createAssistantMessageEventStream();
    const controller = new AbortController();
    fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: modelId, messages: [
        { role: 'system', content: context.systemPrompt ?? '' },
        ...context.messages.map((message) => ({ role: message.role,
          content: Array.isArray(message.content) ? message.content.map((block) => block.text ?? '').join('') : String(message.content ?? '') })),
      ], stream: false }),
    }).then(async (response) => {
      const data = await response.json();
      const usage = data.usage ?? {};
      stream.push({ type: 'start', partial: { role: 'assistant', content: [], usage: {}, timestamp: Date.now() } });
      const message = { role: 'assistant', content: [{ type: 'text', text: data.choices?.[0]?.message?.content ?? '' }],
        api: 'openai-completions', provider: 'story-smoke', model: modelId,
        usage: { input: usage.prompt_tokens ?? 0, output: usage.completion_tokens ?? 0, cacheRead: 0, cacheWrite: 0,
          totalTokens: usage.total_tokens ?? 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop', timestamp: Date.now() };
      stream.push({ type: 'done', reason: 'stop', message });
    }).catch((error) => {
      stream.push({ type: 'error', reason: 'error', error: { role: 'assistant', content: [], usage: {},
        stopReason: 'error', errorMessage: String(error), timestamp: Date.now() } });
    }).finally(() => controller.abort());
    return stream;
  } });
}

const allowedDurations = (process.env.STORY_ALLOWED_DURATIONS ?? '5,10,15,30').split(',').map(Number);
const maxSeconds = Number(process.env.STORY_MAX_SECONDS ?? 90);
const agent = createStoryAgent({ llm, logger: console });
const startedAt = Date.now();
const result = await agent.understand({ storyText, style: { name: '绘本水彩', promptHint: '柔和水彩质感' },
  maxSeconds, allowedDurations });
console.log(JSON.stringify({ degraded: result.degraded, compressed: result.compressed, notice: result.notice ?? null,
  totalSeconds: result.totalSeconds, segmentCount: result.segmentCount,
  cast: result.cast.map((person) => ({ name: person.name, characterId: person.characterId ?? null, voiceId: person.voiceId ?? null })),
  usage: result.usage, elapsedMs: Date.now() - startedAt }, null, 2));
void readFile;

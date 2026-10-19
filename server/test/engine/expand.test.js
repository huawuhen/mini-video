import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { classifyInput, expandIdea, validateExpansion, EXPAND_EXAMPLE, DEFAULT_IDEA_CHAR_THRESHOLD }
  from '../../src/engine/story/expand.js';
import { createStoryAgent } from '../../src/engine/story/index.js';
import { createMockLlm } from '../../src/engine/llm/mock.js';
import { wan30Skill } from '../../src/engine/skills/wan-3.0.js';

const expandInput = (overrides = {}) => ({
  idea: '宝宝在公园里第一次放风筝',
  style: { name: '绘本水彩', promptHint: '柔和水彩、儿童绘本质感' },
  maxSeconds: 90, allowedDurations: [5, 10, 15, 30],
  characters: [{ id: 'chr_baby', name: '宝宝', selected: true, gender: 'female', ageGroup: 'child' }],
  ...overrides,
});
const longScript = (dialogueLines) => ['公园的下午', '场景：公园草地，午后。', ...dialogueLines].join('\n');

describe('engine/story/expand（M1-ENG-04）', () => {
  test('classifyInput：默认约 60 字、无对白与场景描述判为想法；超阈值或有标记判为剧本', () => {
    assert.equal(DEFAULT_IDEA_CHAR_THRESHOLD, 60);
    const idea = '宝宝在公园里第一次放风筝，跑得满头大汗也开心';
    assert.ok(idea.length <= 60);
    assert.equal(classifyInput(idea), 'idea');
    assert.equal(classifyInput('x'.repeat(61)), 'script', '超过阈值按剧本处理');
    assert.equal(classifyInput('宝宝放风筝，妈妈说：慢一点'), 'script', '说：是对白标记');
    assert.equal(classifyInput('宝宝喊：「飞起来啦！」'), 'script', '引号对白');
    assert.equal(classifyInput('场景：公园的草地，午后阳光'), 'script', '场景字段');
    assert.equal(classifyInput('地点：厨房'), 'script');
    assert.equal(classifyInput('宝宝放风筝真开心呀', { ideaCharThreshold: 3 }), 'script', '阈值可配置');
    assert.equal(classifyInput('宝宝放风筝，真开心呀', { ideaCharThreshold: 60 }), 'idea');
    assert.throws(() => classifyInput(''), /故事内容不能为空/);
    assert.throws(() => classifyInput(null), /故事内容不能为空/);
    assert.throws(() => classifyInput('想法', { ideaCharThreshold: 0 }), /阈值不合法/);
  });

  test('契约：扩写示例 JSON 必须通过 validateExpansion，并出现在扩写系统提示中', async () => {
    const parsed = validateExpansion(JSON.parse(JSON.stringify(EXPAND_EXAMPLE)), { dialogueBudget: 210, selectedNames: [] });
    assert.equal(parsed.title, '公园的下午');
    const llm = createMockLlm([{ text: JSON.stringify({ title: 'x', script: '正文' }) }]);
    await expandIdea({ llm, skill: wan30Skill, ...expandInput() });
    const system = llm.calls[0].system;
    assert.ok(system.includes(JSON.stringify(EXPAND_EXAMPLE)), '系统提示必须附带输出契约示例');
    assert.match(system, /目标时长约 60 秒（上限 90 秒）/);
    assert.match(system, /对白总字数不超过 210 个汉字/);
    assert.match(system, /柔和水彩、儿童绘本质感/);
    assert.ok(system.includes('以下人物必须出场，直接使用他们的名字：宝宝。'));
    const message = JSON.parse(llm.calls[0].messages[0].content);
    assert.equal(message.untrustedIdea.text, expandInput().idea);
    assert.ok(!system.includes(expandInput().idea), '想法原文只出现在不可信数据区');
  });

  test('成功扩写：返回 title/script/usage/degraded=false', async () => {
    const llm = createMockLlm([{ text: JSON.stringify({ title: '风筝', script: longScript(['宝宝：「飞喽！」']) }),
      usage: { inputTokens: 7, outputTokens: 9 } }]);
    const result = await expandIdea({ llm, skill: wan30Skill, ...expandInput() });
    assert.deepEqual({ title: result.title, degraded: result.degraded }, { title: '风筝', degraded: false });
    assert.match(result.script, /宝宝：「飞喽！」/);
    assert.deepEqual(result.usage, { inputTokens: 7, outputTokens: 9 });
  });

  test('输出含镜头运镜、缺已选人物、对白超预算：逐项触发修复重试后成功', async () => {
    const good = { title: '风筝', script: longScript(['宝宝：「飞喽！」', '宝宝：「妈妈快看！」']) };
    const overBudget = longScript([
      ...Array.from({ length: 10 }, (_, i) => `宝宝：「第${i}句台词今天真开心呀我们一起放风筝跑了好远好远。」`),
      '宝宝：「飞喽！」']);
    const cases = [
      [{ title: 'x', script: `${good.script}\n镜头拉到宝宝特写。` }, /镜头、运镜或景别/],
      [{ title: 'x', script: longScript(['妈妈：「我们回家吧！」']) }, /在剧本中出场/],
      [{ title: 'x', script: overBudget }, /预算/],
    ];
    for (const [bad, hint] of cases) {
      const llm = createMockLlm([
        { text: JSON.stringify(bad) },
        { text: JSON.stringify(good) },
      ]);
      const result = await expandIdea({ llm, skill: wan30Skill, ...expandInput() });
      assert.equal(llm.calls.length, 2);
      assert.match(llm.calls[1].messages.at(-1).content, hint);
      assert.equal(llm.calls[1].messages.at(-2).role, 'assistant', '修复请求带上一次输出');
      assert.equal(result.degraded, false);
      assert.equal(result.script, good.script);
    }
  });

  test('全部修复失败：确定性兜底直接用想法原文作剧本（degraded）', async () => {
    const llm = createMockLlm(['not json', 'not json', 'not json']);
    const result = await expandIdea({ llm, skill: wan30Skill, ...expandInput({ idea: '宝宝在院子里吹泡泡，追着彩虹跑' }) });
    assert.equal(llm.calls.length, 3);
    assert.equal(result.degraded, true);
    assert.equal(result.script, '宝宝在院子里吹泡泡，追着彩虹跑');
    assert.equal(result.title, '宝宝在院子里吹泡泡，追着彩虹跑'.slice(0, 16));
  });

  test('取消直接抛出且 LLM 调用 ≤ 1 次；挂起超时走兜底', async () => {
    const controller = new AbortController();
    controller.abort(new Error('项目已取消'));
    const cancelLlm = createMockLlm([(request) => new Promise((resolve, reject) => {
      request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
    })]);
    await assert.rejects(() => expandIdea({ llm: cancelLlm, skill: wan30Skill,
      ...expandInput({ signal: controller.signal, timeoutMs: 5000 }) }), /项目已取消/);
    assert.ok(cancelLlm.calls.length <= 1);

    const hangs = createMockLlm([(request) => new Promise(() => {})]);
    const result = await expandIdea({ llm: hangs, skill: wan30Skill, logger: { warn: () => {} },
      ...expandInput({ timeoutMs: 30 }) });
    assert.equal(result.degraded, true);
  });

  test('代理暴露 expandIdea，validateExpansion 标题截断到 16 字', async () => {
    const llm = createMockLlm([{ text: JSON.stringify({ title: '这是一个超过十六个字的标题需要被截断处理', script: '宝宝吹泡泡，追着泡泡跑。' }) }]);
    const agent = createStoryAgent({ llm, logger: { warn: () => {} } });
    const result = await agent.expandIdea(expandInput());
    assert.equal(result.degraded, false);
    assert.equal(result.title.length, 16);
    const parsed = validateExpansion({ title: 'x'.repeat(30), script: '正文' }, { dialogueBudget: 10, selectedNames: [] });
    assert.equal(parsed.title.length, 16);
  });
});

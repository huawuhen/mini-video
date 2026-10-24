// Cross-module consistency check (M1-ENG-04 review must-fix 1, M2-BE-03 改用 aiide-ark 驱动):
// the 图N numbers that `assemble` writes into the prompt must match the actual submission
// order of reference images built by the video driver ([tailRef, ...imageRefs] →
// metadata.content[] of the ark protocol, in order).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createStoryAgent } from '../../src/engine/story/index.js';
import { createMockLlm } from '../../src/engine/llm/mock.js';
import arkDriver from '../../src/engine/providers/drivers/aiide-ark/index.js';
import { createScriptedFetch } from '../../src/engine/providers/contract-test.js';

const SHOTS = { shots: [
  { start: 0, end: 4, size: 'Medium-wide shot', transition: 'cut',
    action: 'The girl raises the kite and runs across the lawn.', dialogue: [], reaction: '',
    environment: 'Grass sways in the breeze.', camera: 'slow tracking shot' },
  { start: 4, end: 9, size: 'Medium shot', transition: 'cut', action: 'The mother claps slowly.',
    dialogue: [], reaction: '', environment: '', camera: 'static' } ], avoid: [] };

describe('提示词 图N 与驱动提交参考图顺序跨模块一致（M1-ENG-04 复审必改 1）', () => {
  function makeAdapter() {
    const scripted = createScriptedFetch([
      { match: '/v1/video/generations', method: 'POST', status: 200,
        json: { id: 'task_numbering', task_id: 'task_numbering', object: 'video', status: '', progress: 0 } },
    ]);
    const adapter = arkDriver.create({
      id: 'pch_numbering0', kind: 'video', name: 'numbering', driver: 'aiide-ark',
      baseUrl: 'https://channel.example.test', credential: 'sk-numbering-test',
      modelMap: { video: 'dreamina-seedance-2-5-hc' }, params: { requestTimeoutMs: 2_000 },
    }, { deps: { fetchImpl: scripted.fetchImpl } });
    return { adapter, scripted };
  }

  async function bindOnce({ usePrevTail }) {
    const llm = createMockLlm([JSON.stringify(SHOTS), JSON.stringify(SHOTS)]);
    const agent = createStoryAgent({ llm });
    const base = { durationSeconds: 9, plot: '宝宝举起风筝奔跑。', castIds: ['cast_m', 'cast_b'],
      sceneId: 's1', propIds: [], endState: 'the girl runs forward with the kite', dialogue: [] };
    // usePrevTail 只对非首段生效：第二段 prev_tail，取它的绑定结果做断言
    const segments = [{ ...base, transition: 'hard_cut' },
      { ...base, plot: '两人一起收线。', transition: usePrevTail ? 'prev_tail' : 'hard_cut' }];
    const [, bound] = await agent.bindPrompts({
      style: { name: '日系动漫' }, segments,
      cast: [
        { id: 'cast_m', name: '妈妈', lookImageKey: 'looks/m.png' },
        { id: 'cast_b', name: '宝宝', lookImageKey: 'looks/b.png' },
      ],
      bible: { mood: 'calm, gentle; warm light',
        characters: [
          { castIndex: 0, handle: 'the mother', brief: 'a woman in her thirties' },
          { castIndex: 1, handle: 'the girl', brief: 'a four-year-old girl' } ],
        scenes: [{ id: 's1', nameZh: '公园草地', description: 'a sunlit park lawn' }], props: [] } });
    return bound;
  }

  test('有尾帧：提交顺序 [tail, ...imageRefs]，提示词 图1 写尾帧、人物从 图2 开始', async () => {
    const bound = await bindOnce({ usePrevTail: true });
    assert.equal(bound.usePrevTail, true);
    assert.deepEqual(bound.imageRefs, ['looks/m.png', 'looks/b.png']);
    assert.match(bound.prompt, /图1：上一段的最后一帧，作为本段起始画面的关键帧参考。/);
    assert.match(bound.prompt, /图2：the mother 的主体参考（锁定外貌与服装）：a woman in her thirties。/);
    assert.match(bound.prompt, /图3：the girl 的主体参考（锁定外貌与服装）：a four-year-old girl。/);
    assert.ok(!/图4：/.test(bound.prompt), '没有多余的图4');
    const { adapter, scripted } = makeAdapter();
    // 与 segment.js 同口径：存储 key 先转上游可访问的引用（生产为签名 URL，此处用 asset:// 免过审），尾帧排最前
    const toRef = (key) => `asset://mat_${key.replace(/[^a-z0-9]/gi, '_')}`;
    await adapter.submit(adapter.prepare({ prompt: bound.prompt,
      imageRefs: ['asset://mat_tail', ...bound.imageRefs.map(toRef)],
      durationSeconds: 9, ratio: '9:16', resolution: '480p' }),
      { idempotencyKey: 'numbering-tail' });
    const content = JSON.parse(scripted.calls[0].body).metadata.content
      .filter((item) => item.type === 'image_url');
    assert.equal(content[0].image_url.url, 'asset://mat_tail', '提交时尾帧排最前');
    assert.equal(content[1].image_url.url, 'asset://mat_looks_m_png', '提示词 图2 = 提交的第 2 张（妈妈的形象图）');
    assert.equal(content[2].image_url.url, 'asset://mat_looks_b_png', '提示词 图3 = 提交的第 3 张（宝宝的形象图）');
    assert.equal(content[3], undefined);
  });

  test('无尾帧：人物从 图1 开始，编号一一对应', async () => {
    const bound = await bindOnce({ usePrevTail: false });
    assert.equal(bound.usePrevTail, false);
    assert.match(bound.prompt, /图1：the mother 的主体参考（锁定外貌与服装）：a woman in her thirties。/);
    assert.match(bound.prompt, /图2：the girl 的主体参考（锁定外貌与服装）：a four-year-old girl。/);
    assert.ok(!bound.prompt.includes('上一段的最后一帧'));
    const { adapter, scripted } = makeAdapter();
    await adapter.submit(adapter.prepare({ prompt: bound.prompt,
      imageRefs: bound.imageRefs.map((key) => `asset://mat_${key.replace(/[^a-z0-9]/gi, '_')}`),
      durationSeconds: 9, ratio: '9:16', resolution: '480p' }), { idempotencyKey: 'numbering-notail' });
    const content = JSON.parse(scripted.calls[0].body).metadata.content
      .filter((item) => item.type === 'image_url');
    assert.equal(content[0].image_url.url, 'asset://mat_looks_m_png');
    assert.equal(content[1].image_url.url, 'asset://mat_looks_b_png');
    assert.equal(content[2], undefined);
  });
});

// Cross-module consistency check (M1-ENG-04 review must-fix 1): the 图N numbers that
// `assemble` writes into the prompt must match the actual submission order of
// `image_file_N` built by the modelhub video adapter ([tailRef, ...imageRefs]).
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { createStoryAgent } from '../../src/engine/story/index.js';
import { createMockLlm } from '../../src/engine/llm/mock.js';
import { createModelhubTransport, createWan30Adapter } from '../../src/engine/providers/index.js';

const SHOTS = { shots: [
  { start: 0, end: 4, size: 'Medium-wide shot', transition: 'cut',
    action: 'The girl raises the kite and runs across the lawn.', dialogue: [], reaction: '',
    environment: 'Grass sways in the breeze.', camera: 'slow tracking shot' },
  { start: 4, end: 9, size: 'Medium shot', transition: 'cut', action: 'The mother claps slowly.',
    dialogue: [], reaction: '', environment: '', camera: 'static' } ], avoid: [] };

function fakeUpstream() {
  const bodies = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ task_id: 'task_numbering' }));
    });
  });
  return { server, bodies };
}

describe('提示词 图N 与提交 image_file_N 跨模块一致（M1-ENG-04 复审必改 1）', () => {
  let upstream;
  let adapter;
  before(async () => {
    upstream = fakeUpstream();
    upstream.server.listen(0, '127.0.0.1');
    await new Promise((resolve) => upstream.server.once('listening', resolve));
    adapter = createWan30Adapter(createModelhubTransport({
      baseUrl: `http://127.0.0.1:${upstream.server.address().port}`, apiKey: 'fixture-token', timeoutMs: 2000 }));
  });
  after(async () => { upstream.server.closeAllConnections(); await new Promise((resolve) => upstream.server.close(resolve)); });

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
    await adapter.submit(adapter.prepare({ prompt: bound.prompt, imageRefs: bound.imageRefs,
      tailRef: 'https://upstream.example/tail.png', durationSeconds: 9, ratio: '9:16' }),
      { idempotencyKey: 'numbering-tail' });
    const body = upstream.bodies.at(-1);
    assert.equal(body.image_file_1, 'https://upstream.example/tail.png', '提交时尾帧排最前');
    assert.equal(body.image_file_2, 'looks/m.png', '提示词 图2 = 提交的第 2 张（妈妈的形象图）');
    assert.equal(body.image_file_3, 'looks/b.png', '提示词 图3 = 提交的第 3 张（宝宝的形象图）');
    assert.equal(body.image_file_4, undefined);
  });

  test('无尾帧：人物从 图1 开始，编号一一对应', async () => {
    const bound = await bindOnce({ usePrevTail: false });
    assert.equal(bound.usePrevTail, false);
    assert.match(bound.prompt, /图1：the mother 的主体参考（锁定外貌与服装）：a woman in her thirties。/);
    assert.match(bound.prompt, /图2：the girl 的主体参考（锁定外貌与服装）：a four-year-old girl。/);
    assert.ok(!bound.prompt.includes('上一段的最后一帧'));
    await adapter.submit(adapter.prepare({ prompt: bound.prompt, imageRefs: bound.imageRefs,
      durationSeconds: 9, ratio: '9:16' }), { idempotencyKey: 'numbering-notail' });
    const body = upstream.bodies.at(-1);
    assert.equal(body.image_file_1, 'looks/m.png');
    assert.equal(body.image_file_2, 'looks/b.png');
    assert.equal(body.image_file_3, undefined);
  });
});

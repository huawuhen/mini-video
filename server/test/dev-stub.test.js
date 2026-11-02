// M2-BE-04②：开发桩 bindPrompts——GEN_UPSTREAMS=mock 的开发环境可走完确认点 B 之后的流程。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDevStoryAgent } from '../src/projects/dev-stub.js';

test('dev-stub bindPrompts：确定性逐段产出契约字段（单镜头 + 对白逐字 + degraded 标记）', async () => {
  const agent = createDevStoryAgent();
  const cast = [{ id: 'cast_1', lookImageKey: 'users/u/looks/a.png' }];
  const bound = await agent.bindPrompts({
    segments: [
      { durationSeconds: 5, plot: '开场', transition: 'hard_cut',
        castIndexes: [0], dialogue: [{ castIndex: 0, line: '你好呀' }], endState: 'she waves' },
      { durationSeconds: 5, plot: '接上段', transition: 'prev_tail', castIndexes: [0], dialogue: [] },
    ],
    cast, bible: { characters: [{ castIndex: 0, handle: 'the girl', brief: 'a girl' }] },
    style: {}, ratio: '9:16', voicesEnabled: false, skillId: 'generic',
  });
  assert.equal(bound.length, 2);
  assert.equal(bound[0].prompt, '[dev stub] 开场');
  assert.deepEqual(bound[0].imageRefs, ['users/u/looks/a.png']);
  assert.equal(bound[0].usePrevTail, false);
  assert.equal(bound[1].usePrevTail, true);
  assert.equal(bound[0].shots.length, 1);
  assert.equal(bound[0].shots[0].end, 5);
  assert.equal(bound[0].shots[0].dialogue[0].line, '你好呀');
  assert.equal(bound[0].degraded, true);
  assert.equal(bound[0].skillId, 'generic');
});

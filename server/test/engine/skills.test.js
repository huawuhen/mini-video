import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { assemble, buildShotMessage, dialogueSentence, fallbackTimeline, hanCharCount, refLabels,
  shotBounds, validateShots, SHOT_EXAMPLE } from '../../src/engine/skills/base.js';
import { createSkillRegistry } from '../../src/engine/skills/index.js';
import { wan30Skill } from '../../src/engine/skills/wan-3.0.js';
import { genericSkill } from '../../src/engine/skills/generic.js';

const registry = createSkillRegistry();
const dialogue = [{ castIndex: 0, line: '妈妈，风筝飞起来啦！' }];

// docs/skills/wan-3.0.md §6 成品示例（前两个镜头、9 秒、已有上一段）。
const ASSEMBLE_INPUT = {
  styleText: 'Japanese anime, cel shading, vivid colors',
  sceneDescription: 'A sunlit city-park lawn in late morning, soft shadows under old maple trees, a checkered picnic blanket in the middle, calm breeze',
  propDescriptions: ['A small red diamond kite with a long white string'],
  characters: [
    { handle: 'the girl', brief: 'a 4-year-old girl with short black hair and a yellow dress' },
    { handle: 'the woman', brief: 'a woman in her thirties with long hair and a white cardigan' },
  ],
  audioHandles: ['the girl', 'the woman'],
  usePrevTail: true,
  startState: 'the girl stands on the blanket holding the kite spool, the woman kneels beside her, both looking up at the sky, medium-wide framing',
  durationSeconds: 9,
  shots: SHOT_EXAMPLE.shots,
  mood: 'warm, gentle, healing; soft golden light',
  shotAvoids: SHOT_EXAMPLE.avoid,
};

describe('engine/skills（M1-ENG-04）', () => {
  test('注册表：按 id 与模型取 Skill，未知模型回退 generic，重复注册报错', () => {
    assert.equal(registry.get('wan-3.0').id, 'wan-3.0');
    assert.deepEqual(registry.get('wan-3.0').models, ['wan-3.0', 'wan-3.0-prime']);
    assert.equal(registry.forModel('wan-3.0-prime').id, 'wan-3.0');
    assert.equal(registry.forModel('seedance-2.5').id, 'generic', '没有专属 Skill 的模型用 generic');
    assert.throws(() => registry.get('nope'), /未知的提示词 Skill/);
    assert.throws(() => createSkillRegistry([wan30Skill, wan30Skill]), /Skill id 重复/);
    assert.throws(() => createSkillRegistry([wan30Skill,
      { ...genericSkill, id: 'x', models: ['wan-3.0'] }]), /被多个 Skill 声明/);
    assert.equal(registry.get('generic'), genericSkill);
  });

  test('契约：§5.3 示例 JSON 必须通过 validateShots，并出现在 shotSystem 提示词里', () => {
    const system = wan30Skill.shotSystem({ durationSeconds: 30, takeMode: 'multi_shot' });
    assert.ok(system.includes(JSON.stringify(SHOT_EXAMPLE)), '系统提示词必须附带输出契约示例');
    assert.match(system, /该片段时长 30 秒/);
    assert.match(system, /4~8 个连续镜头/);
    const parsed = validateShots(JSON.parse(JSON.stringify(SHOT_EXAMPLE)),
      { durationSeconds: 9, dialogue });
    assert.equal(parsed.shots.length, 2);
    assert.deepEqual(parsed.avoid, ['hands crossing the kite string']);
    const single = wan30Skill.shotSystem({ durationSeconds: 30, takeMode: 'single_take' });
    assert.match(single, /只写一个镜头/);
  });

  test('shotBounds：30 秒 4~8、15 秒 2~4、9 秒 1~2，且物理上必须可行（5 秒最多 1 镜）', () => {
    assert.deepEqual(shotBounds(30), { minShots: 4, maxShots: 8 });
    assert.deepEqual(shotBounds(15), { minShots: 2, maxShots: 4 });
    assert.deepEqual(shotBounds(9), { minShots: 1, maxShots: 2 });
    assert.deepEqual(shotBounds(5), { minShots: 1, maxShots: 1 });
    assert.deepEqual(shotBounds(45), { minShots: 4, maxShots: 8 }, '超出表外的时长沿用最大档');
  });

  test('镜头校验：时间不连续、时长越界、数量不符、最后一个镜头不到结尾都拒绝', () => {
    const base = { durationSeconds: 9, dialogue: [] };
    const shot = (start, end, extra = {}) => ({ start, end, size: 'Wide shot', action: 'She walks.',
      dialogue: [], camera: 'static', ...extra });
    assert.throws(() => validateShots({ shots: [shot(0, 4), shot(5, 9)] }, base), /首尾相接/);
    assert.throws(() => validateShots({ shots: [shot(0, 9)] }, base), /3~8 秒之间|时长必须/);
    assert.throws(() => validateShots({ shots: [shot(1, 4), shot(4, 9)] }, base), /从 0 秒开始/);
    assert.throws(() => validateShots({ shots: [shot(0, 4), shot(4, 10)] }, base), /结束于 9 秒/);
    assert.throws(() => validateShots({ shots: [shot(0, 9)] }, { ...base, durationSeconds: 30 }), /镜头数量/);
    assert.throws(() => validateShots({ shots: [] }, base), /shots 数组/);
    // 含对白镜头放宽到 10 秒，无对白镜头 8 秒封顶
    const withLine = { start: 0, end: 10, size: 'Close-up', action: 'She speaks.', dialogue: [{ castIndex: 0, line: '你好呀朋友' }], camera: 'static' };
    assert.equal(validateShots({ shots: [withLine] }, { durationSeconds: 10, dialogue: [{ castIndex: 0, line: '你好呀朋友' }] }).shots.length, 1);
    assert.throws(() => validateShots({ shots: [{ ...withLine, dialogue: [] }] },
      { durationSeconds: 10, dialogue: [] }), /时长必须在/);
  });

  test('镜头校验：英文字段禁中文、对白逐字一致、单句不超语速预算', () => {
    const base = { durationSeconds: 9, dialogue };
    const shots = () => JSON.parse(JSON.stringify(SHOT_EXAMPLE.shots));
    const mutated = shots();
    mutated[0].action = '她慢慢跑起来。';
    assert.throws(() => validateShots({ shots: mutated }, base), /动作必须是英文/);
    const delivery = shots();
    delivery[1].dialogue[0].delivery = '兴奋地';
    assert.throws(() => validateShots({ shots: delivery }, base), /说话方式必须是英文/);
    const avoidCn = { shots: shots(), avoid: ['不要水印'] };
    assert.throws(() => validateShots(avoidCn, base), /avoid\s*必须是英文/);
    // 对白改写一个字即拒绝
    const reworded = shots();
    reworded[1].dialogue[0].line = '妈妈，风筝飞起来了！';
    assert.throws(() => validateShots({ shots: reworded }, base), /逐字一致/);
    // 说话人换人拒绝
    const swapped = shots();
    swapped[1].dialogue[0].castIndex = 1;
    assert.throws(() => validateShots({ shots: swapped }, base), /逐字一致/);
    // 少一句、多一句都拒绝；一句拆成两句会因文字不一致被拒（逐字校验）
    assert.throws(() => validateShots({ shots: shots().map((s) => ({ ...s, dialogue: [] })) }, base), /数量不一致/);
    const extra = shots();
    extra[0].dialogue = [{ castIndex: 0, line: '看！' }];
    assert.throws(() => validateShots({ shots: extra }, base), /数量不一致/);
    const split = shots();
    split[1].dialogue = [
      { castIndex: 0, line: '妈妈，风筝飞起来' },
      { castIndex: 0, line: '啦！' } ];
    assert.throws(() => validateShots({ shots: split }, base), /数量不一致/,
      '一句拆成两句后句数与文字都对不上');
    // 语速预算：9 个汉字 ≤ 5 秒 × 3.5=17.5 通过；12 字塞进 3 秒镜头（10.5）拒绝
    assert.equal(validateShots({ shots: shots() }, base).shots[1].dialogue[0].line, dialogue[0].line);
    const crowded = shots();
    crowded[0].end = 8;
    crowded[1].start = 8;
    crowded[1].end = 11;
    crowded[1].dialogue[0].line = '妈妈你快看呀风筝飞得真高';
    crowded.push({ start: 11, end: 14, size: 'Wide shot', action: 'They hug.', dialogue: [], camera: 'static' });
    assert.throws(() => validateShots({ shots: crowded },
      { durationSeconds: 14, dialogue: [{ castIndex: 0, line: crowded[1].dialogue[0].line }] }), /语速预算/);
    assert.equal(hanCharCount('妈妈，风筝飞起来啦！'), 8, '标点不计入汉字数');
  });

  test('拼装：与 docs/skills/wan-3.0.md §6 成品示例逐字一致（连贯性行按模板归一化为中文句号）', () => {
    const prompt = assemble({ ...ASSEMBLE_INPUT, handles: { 0: 'the girl', 1: 'the woman' } });
    assert.equal(prompt, [
      'Japanese anime, cel shading, vivid colors. A sunlit city-park lawn in late morning, soft shadows under old maple trees, a checkered picnic blanket in the middle, calm breeze. A small red diamond kite with a long white string.',
      '参考素材：',
      '图1：the girl 的主体参考（锁定外貌与服装）：a 4-year-old girl with short black hair and a yellow dress。',
      '图2：the woman 的主体参考（锁定外貌与服装）：a woman in her thirties with long hair and a white cardigan。',
      '图3：上一段的最后一帧，作为本段起始画面的关键帧参考。',
      '音色参考音频1：the girl 的音色，该角色所有台词使用此音色。',
      '音色参考音频2：the woman 的音色，该角色所有台词使用此音色。',
      '连贯性：本段从上一段结尾自然开始：the girl stands on the blanket holding the kite spool, the woman kneels beside her, both looking up at the sky, medium-wide framing。',
      'Total 9 seconds. Realistic performance, natural pacing.',
      '第1个镜头[0-4秒] Medium-wide shot. The girl raises the kite with both hands and runs three steps across the grass while the woman rises to her feet and watches. Grass sways in the breeze. Camera: slow tracking shot following the girl.',
      '第2个镜头[4-9秒] Close-up. The girl glances back at the woman, eyes wide. The girl says in Mandarin Chinese, excited and breathless: “妈妈，风筝飞起来啦！” The woman smiles, her shoulders loosen, and she nods once. Camera: static.',
      'Lip sync.',
      'Audio: ambient sound follows the on-screen action; no background music.',
      'Mood: warm, gentle, healing; soft golden light.',
      'Avoid: exaggerated acting, sudden whip pans, morphing faces, distorted hands, subtitles, text, watermarks; hands crossing the kite string.',
    ].join('\n'));
  });

  test('拼装变体：无对白写 No dialogue、无道具省略、 dissolve 转场、handle 回退 character N', () => {
    const quiet = assemble({ durationSeconds: 5, shots: [{ start: 0, end: 5, size: 'Wide shot',
      transition: 'cut', action: 'Rain falls on the window.', dialogue: [], reaction: '',
      environment: '', camera: 'static' }] });
    assert.match(quiet, /No dialogue\./);
    assert.ok(!quiet.includes('参考素材'), '没有任何参考时省略素材块');
    assert.ok(!quiet.startsWith(' '), quiet.split('\n')[0]);
    assert.match(quiet, /Avoid: exaggerated acting[^;]*\.$/, '没有镜头级 avoid 时不出现分号');
    const dissolve = assemble({ durationSeconds: 9, shots: [
      { start: 0, end: 4, size: 'Wide shot', transition: 'dissolve', action: 'She closes the door.',
        dialogue: [{ castIndex: 2, line: '晚安。' }], reaction: '', environment: '', camera: 'static' },
      { start: 4, end: 9, size: 'Close-up', transition: 'cut', action: 'She smiles.', dialogue: [],
        reaction: '', environment: '', camera: 'pan' } ] });
    assert.match(dissolve, /Dissolve to the next shot\./);
    assert.ok(!/Close-up[^\n]*Dissolve/.test(dissolve), '最后一个镜头的 dissolve 不输出');
    assert.match(dissolve, /Character 3 says in Mandarin Chinese: “晚安。”/, '缺 handle 时回退 character N');
    const multiProps = assemble({ durationSeconds: 5, propDescriptions: ['A red kite.', 'A wicker basket'],
      shots: [{ start: 0, end: 5, size: 'Wide shot', transition: 'cut', action: 'They play.',
        dialogue: [], reaction: '', environment: '', camera: 'static' }] });
    assert.match(multiProps, /^A red kite; A wicker basket\./m, '多个道具用分号连接');
  });

  test('参考素材编号：图N 与 imageRefs 同序、尾帧取下一个编号、音频单独编号', () => {
    const labels = refLabels({ imageCount: 2, audioCount: 2, usePrevTail: true });
    assert.deepEqual(labels.images, ['图1', '图2']);
    assert.equal(labels.tail, '图3');
    assert.deepEqual(labels.audio, ['音色参考音频1', '音色参考音频2']);
  });

  test('对白句：handle 首字母大写起句，delivery 缺省时省略逗号部分，对白原句不改动', () => {
    assert.equal(dialogueSentence('the girl', '你好。', ''), 'The girl says in Mandarin Chinese: “你好。”');
    assert.equal(dialogueSentence('the girl', '你好。', 'softly'), 'The girl says in Mandarin Chinese, softly: “你好。”');
  });

  test('兜底时间线：整段一镜、剧情进 action、对白由代码嵌入', () => {
    const { shots, avoid } = fallbackTimeline({ durationSeconds: 30, plot: '宝宝追逐树叶。',
      dialogue: [{ castIndex: 1, line: '飞起来啦！' }] });
    assert.equal(shots.length, 1);
    assert.equal(shots[0].start, 0);
    assert.equal(shots[0].end, 30);
    assert.match(shots[0].action, /Follow this plot with realistic performance and natural pacing: 宝宝追逐树叶。/);
    assert.deepEqual(shots[0].dialogue, [{ castIndex: 1, line: '飞起来啦！', delivery: '' }]);
    assert.deepEqual(avoid, []);
    const prompt = assemble({ durationSeconds: 30, shots, characters: [], handles: { 1: 'the girl' } });
    assert.match(prompt, /第1个镜头\[0-30秒\]/);
    assert.match(prompt, /The girl says in Mandarin Chinese: “飞起来啦！”/);
  });

  test('镜头用户消息：任务字段与不可信数据区齐全', () => {
    const message = JSON.parse(buildShotMessage({ durationSeconds: 9, takeMode: 'multi_shot',
      plot: '宝宝追树叶', startState: 'she stands', endState: 'she sits',
      scene: { id: 's1', nameZh: '公园', description: 'a park lawn' },
      props: [{ id: 'p1', nameZh: '风筝', description: 'a red kite' }],
      characters: [{ handle: 'the girl', brief: 'a girl' }],
      dialogue: [{ castIndex: 0, handle: 'the girl', line: '飞啦！' }],
      cameraNotes: '跟拍', ambience: '风声' }));
    assert.equal(message.task, 'write_shot_timeline');
    assert.equal(message.untrusted.text, '宝宝追树叶');
    assert.deepEqual(message.dialogue, [{ castIndex: 0, handle: 'the girl', line: '飞啦！' }]);
    assert.deepEqual(message.scene, { id: 's1', description: 'a park lawn' });
    assert.deepEqual(message.props, [{ id: 'p1', description: 'a red kite' }]);
  });

  test('generic Skill：可独立完成校验与拼装，limits 使用共享默认值', () => {
    assert.deepEqual(genericSkill.limits, wan30Skill.limits);
    const system = genericSkill.shotSystem({ durationSeconds: 9, takeMode: 'multi_shot' });
    assert.ok(system.includes(JSON.stringify(SHOT_EXAMPLE)));
    const parsed = validateShots(JSON.parse(JSON.stringify(SHOT_EXAMPLE)),
      { durationSeconds: 9, dialogue, limits: genericSkill.limits });
    assert.equal(parsed.shots.length, 2);
    assert.match(genericSkill.planningGuide, /hard_cut/);
    assert.match(wan30Skill.planningGuide, /30 秒/);
  });
});

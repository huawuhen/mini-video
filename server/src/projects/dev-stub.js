// 开发/测试缺省 story agent：返回固定合法的规划结果（引擎契约同构），让 worker 在没有
// 真实 LLM 配置时也能跑通流程结构；生产环境必须注入真实 storyAgent（worker 守卫）。
// 永远 degraded: true——本桩不产出真实内容。
function basePlan() {
  return {
    title: '示例短片',
    synopsis: '开发环境的确定性示例规划：主角走进房间环顾四周。',
    compressed: false,
    totalSeconds: 5,
    segmentCount: 1,
    bible: {
      mood: 'plain, calm; soft daylight',
      characters: [{ castIndex: 0, handle: 'the protagonist', brief: 'the story protagonist in casual clothes' }],
      scenes: [{ id: 's1', nameZh: '房间',
        description: 'a simply furnished room in soft daylight, a window on the left' }],
      props: [],
    },
    cast: [{ name: '主角', description: '故事主角', gender: 'unknown', ageGroup: 'young' }],
    segments: [{
      durationSeconds: 5, plot: '主角走进房间，环顾四周。', cameraNotes: '', dialogue: [],
      ambience: '', transition: 'hard_cut', castIndexes: [0], sceneId: 's1', propIds: [],
      endState: 'the protagonist stands still in the middle of the room, medium shot',
      takeMode: 'multi_shot',
    }],
  };
}

const USAGE = { inputTokens: 0, outputTokens: 0 };

export function createDevStoryAgent() {
  return {
    async expandIdea({ idea }) {
      return { title: String(idea ?? '').slice(0, 16) || '示例短片',
        script: '主角走进房间，环顾四周。', usage: USAGE, degraded: true };
    },
    async understand() {
      const plan = basePlan();
      return { ...plan, degraded: true, inputKind: 'script', expanded: false,
        script: plan.synopsis, usage: USAGE };
    },
    async bindPrompts() {
      throw new Error('开发桩不提供 bindPrompts，请注入真实 storyAgent');
    },
  };
}

/** 开发缺省视频渠道：提交即返回受理，轮询永远失败——真实渠道以 M0 结论为准（M2-BE-01 接入）。 */
export function createDevVideoProvider() {
  let seq = 0;
  return {
    id: 'dev-video',
    prepare(input) { return input; },
    async submit(prepared, { idempotencyKey } = {}) {
      seq += 1;
      return { status: 'running', upstreamId: `dev-${idempotencyKey ?? seq}` };
    },
    async query() { return { status: 'failed', error: '开发环境没有真实视频渠道' }; },
    normalize(raw) { return raw; },
  };
}

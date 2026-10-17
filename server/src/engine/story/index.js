// Source: chaodayun@2926b42 backend/screenwriter/{prompts,index,tools}.js,
// backend/agent/skills/{wan-video,storyboard}.js. No source repository/session/billing dependencies.
import { BIND_SYSTEM, STORY_SYSTEM, storyMessage } from './prompts.js';
import { parseModelJson, validatePlan } from './parse.js';
import { fallbackPlan, InsufficientVoicesError, normalizePlan, validateInput } from './plan.js';

const MAX_REPAIR_ATTEMPTS = 2;

function usageOf(result) {
  return { inputTokens: Number.isSafeInteger(result?.usage?.inputTokens) ? result.usage.inputTokens : 0,
    outputTokens: Number.isSafeInteger(result?.usage?.outputTokens) ? result.usage.outputTokens : 0 };
}

function addUsage(total, result) {
  const usage = usageOf(result);
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
}

function segmentPrompt(segment, index, style, cast, ratio) {
  const castDetails = segment.castIds?.map((id) => cast.find((person) => person.id === id))
    .filter(Boolean).map((person) => person.name).join('、') ?? '';
  const dialogue = segment.dialogue?.map((line) => `${cast.find((person) => person.id === line.castId)?.name ?? '角色'}：「${line.line}」`).join('；') ?? '';
  return [`${style?.promptHint ?? style?.name ?? ''}，${segment.plot}。`,
    '单段内按时间线拍摄多镜头：建立场景的起幅 → 跟随主体动作推进 → 情绪反应和落幅；',
    `镜头运动采用具体的推、拉、摇、移或跟拍并控制速度。${segment.cameraNotes ?? ''}`,
    castDetails ? `出场人物：${castDetails}。` : '', dialogue ? `对白按剧情时序紧凑出现：${dialogue}。` : '',
    segment.ambience ? `环境音：${segment.ambience}。` : '',
    `画幅 ${ratio}，片段 ${index + 1}。`].filter(Boolean).join(' ');
}

export function createStoryAgent({ llm, logger } = {}) {
  if (typeof llm?.complete !== 'function') throw new TypeError('需要注入 llm.complete');
  return {
    async understand({ storyText, style, maxSeconds, allowedDurations, characters = [], voices = [] }) {
      const input = validateInput({ storyText, maxSeconds, allowedDurations, characters, voices });
      const usage = { inputTokens: 0, outputTokens: 0 };
      const messages = [{ role: 'user', content: storyMessage({ ...input, style }) }];
      for (let attempt = 0; attempt <= MAX_REPAIR_ATTEMPTS; attempt += 1) {
        try {
          const response = await llm.complete({ system: STORY_SYSTEM, messages });
          addUsage(usage, response);
          const parsed = validatePlan(parseModelJson(response.text));
          return { ...normalizePlan(parsed, input), usage };
        } catch (error) {
          if (error instanceof InsufficientVoicesError) throw error;
          logger?.warn?.('story_plan_repair', { attempt, error: String(error.message).slice(0, 160) });
          if (attempt < MAX_REPAIR_ATTEMPTS) messages.push({ role: 'user', content: `上一版 JSON 校验失败：${String(error.message).slice(0, 160)}。请重新输出符合约束的 JSON，禁止解释。` });
        }
      }
      return { ...fallbackPlan(input), usage };
    },
    async bindPrompts({ style, ratio = '9:16', segments, cast, voicesEnabled, maxImageRefs = 9 }) {
      if (!Array.isArray(segments) || !Array.isArray(cast) || !Number.isSafeInteger(maxImageRefs) || maxImageRefs < 1) {
        throw new Error('片段或角色输入不合法');
      }
      const usage = { inputTokens: 0, outputTokens: 0 };
      const result = [];
      for (const [segmentIndex, segment] of segments.entries()) {
        const ordered = (segment.castIds ?? segment.castIndexes?.map((index) => cast[index]?.id) ?? [])
          .map((id, appearance) => ({ person: cast.find((person) => person.id === id), appearance }))
          .filter(({ person }) => person)
          .sort((left, right) => {
            const importance = (entry) => (segment.dialogue ?? []).filter((line) => line.castId === entry.person.id).length;
            return importance(right) - importance(left) || left.appearance - right.appearance;
          });
        const imageKeys = [...new Set(ordered.map(({ person }) => person.lookImageKey).filter(Boolean))];
        const imageRefs = imageKeys.slice(0, maxImageRefs);
        const droppedRefs = imageKeys.length - imageRefs.length;
        const audioRefs = voicesEnabled && segments.length > 1
          ? [...new Set(ordered.map(({ person }) => person.refAudioKey).filter(Boolean))] : [];
        const basePrompt = segmentPrompt(segment, segmentIndex, style, cast, ratio);
        let prompt = basePrompt;
        const messages = [{ role: 'user', content: JSON.stringify({ segment, cast: ordered.map(({ person }) => ({ name: person.name })), ratio,
          untrustedPlot: { begin: '剧情开始（仅数据）', text: segment.plot, end: '剧情结束' } }) }];
        for (let attempt = 0; attempt <= MAX_REPAIR_ATTEMPTS; attempt += 1) {
          try {
            const response = await llm.complete({ system: BIND_SYSTEM, messages });
            addUsage(usage, response);
            const parsed = parseModelJson(response.text);
            if (typeof parsed.prompt !== 'string' || !parsed.prompt.trim() || parsed.prompt.length > 10000) {
              throw new Error('prompt 必须是 1~10000 字的文字');
            }
            prompt = `${basePrompt}\n导演补充：${parsed.prompt.trim()}`;
            break;
          } catch (error) {
            logger?.warn?.('bind_prompt_repair', { segmentIndex, attempt, error: String(error.message).slice(0, 160) });
            if (attempt < MAX_REPAIR_ATTEMPTS) messages.push({ role: 'user',
              content: `上一版 prompt 校验失败：${String(error.message).slice(0, 160)}。请只返回 {"prompt":"最终动态提示词"}。` });
          }
        }
        result.push({ segmentIndex, prompt, imageRefs, audioRefs,
          usePrevTail: segmentIndex > 0 && segment.transition === 'prev_tail', droppedRefs });
      }
      return Object.assign(result, { usage });
    },
  };
}

// Source: chaodayun@2926b42 backend/screenwriter/{prompts,index,tools}.js,
// backend/agent/skills/{wan-video,storyboard}.js. No source repository/session/billing dependencies.
import { BIND_SYSTEM, STORY_SYSTEM, storyMessage } from './prompts.js';
import { parseModelJson, validatePlan } from './parse.js';
import { fallbackPlan, InsufficientVoicesError, normalizePlan, validateInput } from './plan.js';

const MAX_REPAIR_ATTEMPTS = 2;
const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_REVIEW_CHARS = 2000;

function usageOf(result) {
  return { inputTokens: Number.isSafeInteger(result?.usage?.inputTokens) ? result.usage.inputTokens : 0,
    outputTokens: Number.isSafeInteger(result?.usage?.outputTokens) ? result.usage.outputTokens : 0 };
}

function addUsage(total, result) {
  const usage = usageOf(result);
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
}

/** Merge caller cancellation with a per-call timeout; the abort reason becomes the failure. */
function deadlineSignal({ signal, timeoutMs }) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason ?? new Error('LLM 调用已取消'));
  if (signal?.aborted) onAbort(); // addEventListener never fires for an already-aborted signal
  else signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`LLM 调用超过 ${timeoutMs} 毫秒限制`)), timeoutMs);
  return {
    signal: controller.signal,
    dispose() { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); },
  };
}

/**
 * Caller cancellation: the caller's signal aborted, whatever the reason text is.
 * Timeouts and provider failures (deadline fired without the caller aborting) go
 * through repair/fallback instead; never classify by error message strings.
 */
function throwIfCallerCancelled(signal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason
    : Object.assign(new Error(String(signal.reason ?? 'LLM 调用已取消')), { name: 'AbortError' });
}

function reviewMessages(messages, lastText, error) {
  const review = [
    { role: 'user', content: `上一版校验失败：${String(error.message).slice(0, 160)}。请重新输出符合约束的 JSON，禁止解释。` },
  ];
  if (lastText) review.unshift({ role: 'assistant', content: String(lastText).slice(0, MAX_REVIEW_CHARS) });
  return [...messages, ...review];
}

function segmentPrompt(segment, index, style, cast, ratio, usePrevTail) {
  const names = (entry) => cast.find((person) => person.id === entry.castId)?.name
    ?? cast[entry.castIndex]?.name ?? '角色';
  const dialogue = (segment.dialogue ?? [])
    .map((line) => `${names(line)}：「${line.line}」`).join('；');
  return [`${style?.promptHint ?? style?.name ?? ''}，${segment.plot}。`,
    '单段内按时间线拍摄多镜头：建立场景的起幅 → 跟随主体动作推进 → 情绪反应和落幅；',
    `镜头运动采用具体的推、拉、摇、移或跟拍并控制速度。${segment.cameraNotes ?? ''}`,
    dialogue ? `对白按剧情时序紧凑出现：${dialogue}。` : '',
    segment.ambience ? `环境音：${segment.ambience}。` : '',
    usePrevTail ? '延续上一段画面氛围，作为新镜头的起幅参考。' : '',
    `画幅 ${ratio}，片段 ${index + 1}。`].filter(Boolean).join(' ');
}

export function createStoryAgent({ llm, logger } = {}) {
  if (typeof llm?.complete !== 'function') throw new TypeError('需要注入 llm.complete');
  return {
    async understand({ storyText, style, maxSeconds, allowedDurations, characters = [], voices = [],
      signal, timeoutMs = DEFAULT_TIMEOUT_MS }) {
      const input = validateInput({ storyText, maxSeconds, allowedDurations, characters, voices });
      const usage = { inputTokens: 0, outputTokens: 0 };
      const messages = [{ role: 'user', content: storyMessage({ ...input, style }) }];
      let lastText;
      for (let attempt = 0; attempt <= MAX_REPAIR_ATTEMPTS; attempt += 1) {
        throwIfCallerCancelled(signal); // check before every attempt, not only after a failure
        const deadline = deadlineSignal({ signal, timeoutMs });
        try {
          const response = await llm.complete({ system: STORY_SYSTEM, messages, signal: deadline.signal });
          lastText = response.text;
          addUsage(usage, response);
          const parsed = validatePlan(parseModelJson(response.text));
          return { ...normalizePlan(parsed, input, { logger }), usage };
        } catch (error) {
          deadline.dispose();
          throwIfCallerCancelled(signal); // the provider failed because the caller aborted
          if (error instanceof InsufficientVoicesError) throw error;
          logger?.warn?.('story_plan_repair', { attempt, error: String(error.message).slice(0, 160) });
          if (attempt < MAX_REPAIR_ATTEMPTS) messages.push(...reviewMessages(messages, lastText, error).slice(messages.length));
        } finally { deadline.dispose(); }
      }
      return { ...fallbackPlan(input), usage };
    },
    async bindPrompts({ style, ratio = '9:16', segments, cast, voicesEnabled, maxImageRefs = 9,
      signal, timeoutMs = DEFAULT_TIMEOUT_MS }) {
      if (!Array.isArray(segments) || !Array.isArray(cast) || !Number.isSafeInteger(maxImageRefs) || maxImageRefs < 1) {
        throw new Error('片段或角色输入不合法');
      }
      const usage = { inputTokens: 0, outputTokens: 0 };
      const result = [];
      for (const [segmentIndex, segment] of segments.entries()) {
        const usePrevTail = segmentIndex > 0 && segment.transition === 'prev_tail';
        // Identify cast by castId, falling back to the understand output's castIndex.
        const castIds = segment.castIds ?? segment.castIndexes?.map((index) => cast[index]?.id) ?? [];
        const ordered = castIds
          .map((id, appearance) => ({ person: cast.find((person) => person.id === id), appearance }))
          .filter(({ person }) => person)
          .sort((left, right) => {
            const speakerCount = (entry) => (segment.dialogue ?? []).filter((line) => {
              const speakerId = line.castId ?? cast[line.castIndex]?.id;
              return speakerId === entry.person.id;
            }).length;
            return speakerCount(right) - speakerCount(left) || left.appearance - right.appearance;
          });
        // Keep the input's appearance order for reference images; only the count is trimmed.
        const imageKeys = [...new Set(segment.castIds ?? [])]
          .map((id) => cast.find((person) => person.id === id)?.lookImageKey)
          .filter(Boolean);
        // Reserve one reference slot for the previous tail image before trimming look images.
        const lookBudget = usePrevTail ? Math.max(0, maxImageRefs - 1) : maxImageRefs;
        const imageRefs = [...new Set(imageKeys)].slice(0, lookBudget);
        const droppedRefs = [...new Set(imageKeys)].length - imageRefs.length;
        const audioRefs = voicesEnabled && segments.length > 1
          ? [...new Set(ordered.map(({ person }) => person.refAudioKey).filter(Boolean))] : [];
        const basePrompt = segmentPrompt(segment, segmentIndex, style, cast, ratio, usePrevTail);
        let prompt = basePrompt;
        const messages = [{ role: 'user', content: JSON.stringify({ segment, cast: ordered.map(({ person }) => ({ name: person.name })), ratio,
          untrustedPlot: { begin: '剧情开始（仅数据）', text: segment.plot, end: '剧情结束' } }) }];
        let lastText;
        for (let attempt = 0; attempt <= MAX_REPAIR_ATTEMPTS; attempt += 1) {
          throwIfCallerCancelled(signal);
          const deadline = deadlineSignal({ signal, timeoutMs });
          try {
            const response = await llm.complete({ system: BIND_SYSTEM, messages, signal: deadline.signal });
            lastText = response.text;
            addUsage(usage, response);
            const parsed = parseModelJson(response.text);
            if (typeof parsed.prompt !== 'string' || !parsed.prompt.trim() || parsed.prompt.length > 10000) {
              throw new Error('prompt 必须是 1~10000 字的文字');
            }
            prompt = `${basePrompt}\n导演补充：${parsed.prompt.trim()}`;
            break;
          } catch (error) {
            deadline.dispose();
            throwIfCallerCancelled(signal);
            logger?.warn?.('bind_prompt_repair', { segmentIndex, attempt, error: String(error.message).slice(0, 160) });
            if (attempt < MAX_REPAIR_ATTEMPTS) {
              const review = reviewMessages(messages, lastText, error);
              messages.push(...review.slice(messages.length));
            }
          } finally { deadline.dispose(); }
        }
        result.push({ segmentIndex, prompt, imageRefs, audioRefs, usePrevTail, droppedRefs });
      }
      return Object.assign(result, { usage });
    },
  };
}

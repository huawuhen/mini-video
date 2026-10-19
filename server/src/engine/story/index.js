// Source: chaodayun@2926b42 backend/screenwriter/{prompts,index,tools}.js,
// backend/agent/skills/{wan-video,storyboard}.js. No source repository/session/billing dependencies.
// M1-ENG-04: per-model prompt skills, story bible, per-segment endState + shot timeline,
// code-assembled final prompts (docs/skills/wan-3.0.md v2, ARCHITECTURE §5).
import { storySystem, storyMessage } from './prompts.js';
import { parseModelJson, validatePlan } from './parse.js';
import { assertDialogueFromSource, fallbackPlan, InsufficientVoicesError, normalizePlan, validateInput } from './plan.js';
import { expandIdea as expandIdeaImpl, classifyInput } from './expand.js';
import { createSkillRegistry, DEFAULT_SKILL_ID } from '../skills/index.js';
import { addUsage, deadlineSignal, MAX_REPAIR_ATTEMPTS, reviewMessages, throwIfCallerCancelled,
  DEFAULT_TIMEOUT_MS } from './call.js';

function resolveSkill(skills, skillId) {
  return skills.get(skillId ?? DEFAULT_SKILL_ID);
}

/** Trim the assembled prompt to the Skill's maxChars: drop shot-level avoid, then shorten
 * environments; still over → validation failure so the model gets another try (§7 rule 5). */
function fitPrompt(skill, base, shots, avoid, maxChars) {
  const render = (currentShots, currentAvoid) => skill.assemble({ ...base, shots: currentShots, shotAvoids: currentAvoid });
  let prompt = render(shots, avoid);
  let trimmedShots = shots;
  let trimmedAvoid = avoid;
  if (prompt.length > maxChars) {
    trimmedAvoid = [];
    prompt = render(trimmedShots, trimmedAvoid);
  }
  if (prompt.length > maxChars) {
    trimmedShots = shots.map((shot) => ({ ...shot, environment: shot.environment.slice(0, 80) }));
    prompt = render(trimmedShots, trimmedAvoid);
  }
  if (prompt.length > maxChars) throw new Error(`最终提示词超过 ${maxChars} 字上限`);
  return { prompt, shots: trimmedShots, avoid: trimmedAvoid };
}

export function createStoryAgent({ llm, logger, skills = createSkillRegistry() } = {}) {
  if (typeof llm?.complete !== 'function') throw new TypeError('需要注入 llm.complete');
  return {
    async expandIdea({ idea, style, maxSeconds, allowedDurations, characters, skillId, signal,
      timeoutMs } = {}) {
      return expandIdeaImpl({ llm, logger, skill: resolveSkill(skills, skillId), idea, style, maxSeconds,
        allowedDurations, characters, signal, timeoutMs });
    },

    async understand({ storyText, inputKind = 'script', expanded = false, style, maxSeconds,
      allowedDurations, characters = [], voices = [], skillId, signal, timeoutMs = DEFAULT_TIMEOUT_MS }) {
      const input = validateInput({ storyText, maxSeconds, allowedDurations, characters, voices });
      const skill = resolveSkill(skills, skillId);
      const meta = { script: input.storyText.trim(),
        inputKind: inputKind === 'idea' ? 'idea' : 'script', expanded: Boolean(expanded) };
      // 剧本忠实模式（含确认点 A 编辑后的剧本与扩写结果）：对白逐句必须来自原文，确定性比对。
      const faithful = meta.inputKind === 'script' || meta.expanded;
      const usage = { inputTokens: 0, outputTokens: 0 };
      const messages = [{ role: 'user', content: storyMessage({ ...input, inputKind: meta.inputKind,
        expanded: meta.expanded, style }) }];
      let lastText;
      for (let attempt = 0; attempt <= MAX_REPAIR_ATTEMPTS; attempt += 1) {
        throwIfCallerCancelled(signal); // check before every attempt, not only after a failure
        const deadline = deadlineSignal({ signal, timeoutMs });
        try {
          const response = await llm.complete({ system: storySystem(skill.planningGuide), messages, signal: deadline.signal });
          lastText = response.text;
          addUsage(usage, response);
          const parsed = validatePlan(parseModelJson(response.text));
          if (faithful) assertDialogueFromSource(parsed, input.storyText);
          return { ...normalizePlan(parsed, input, { logger }), ...meta, usage };
        } catch (error) {
          deadline.dispose();
          throwIfCallerCancelled(signal); // the provider failed because the caller aborted
          if (error instanceof InsufficientVoicesError) throw error;
          logger?.warn?.('story_plan_repair', { attempt, error: String(error.message).slice(0, 160) });
          if (attempt < MAX_REPAIR_ATTEMPTS) messages.push(...reviewMessages(messages, lastText, error).slice(messages.length));
        } finally { deadline.dispose(); }
      }
      return { ...fallbackPlan(input), ...meta, usage };
    },

    async bindPrompts({ style, ratio = '9:16', segments, cast, bible, voicesEnabled = false, skillId,
      maxImageRefs, signal, timeoutMs = DEFAULT_TIMEOUT_MS }) {
      if (!Array.isArray(segments) || !Array.isArray(cast)) throw new Error('片段或角色输入不合法');
      const skill = resolveSkill(skills, skillId);
      const limits = { ...skill.limits };
      if (maxImageRefs !== undefined) {
        if (!Number.isSafeInteger(maxImageRefs) || maxImageRefs < 1) throw new Error('maxImageRefs 不合法');
        limits.maxImageRefs = maxImageRefs;
      }
      // bible 里的英文简称与外观按 castIndex 对应；缺失时用确定性回退，保证提示词仍为英文。
      const handles = new Map();
      const briefs = new Map();
      for (const entry of bible?.characters ?? []) {
        if (entry && Number.isInteger(entry.castIndex)) {
          handles.set(entry.castIndex, String(entry.handle));
          briefs.set(entry.castIndex, String(entry.brief));
        }
      }
      const handleFor = (index) => handles.get(index) ?? `character ${index + 1}`;
      const briefFor = (index) => briefs.get(index) ?? 'story character, appearance follows the reference image';
      const handlesMap = Object.fromEntries(cast.map((_, index) => [index, handleFor(index)]));
      const mood = typeof bible?.mood === 'string' ? bible.mood : '';
      // 画幅不进提示词正文：由生成请求的 ratio 字段表达（docs/skills/wan-3.0.md §6 模板无画幅块）。
      void ratio;
      const usage = { inputTokens: 0, outputTokens: 0 };
      const result = [];
      for (const [segmentIndex, segment] of segments.entries()) {
        const durationSeconds = segment?.durationSeconds;
        if (!Number.isInteger(durationSeconds) || durationSeconds <= 0) {
          throw new Error(`第 ${segmentIndex + 1} 段缺少合法时长`);
        }
        const usePrevTail = segmentIndex > 0 && segment.transition === 'prev_tail';
        // Identify cast by castId, falling back to the understand output's castIndex.
        const orderedIds = [...new Set(segment.castIds
          ?? segment.castIndexes?.map((index) => cast[index]?.id).filter(Boolean) ?? [])];
        const personAt = (id) => cast.find((item) => item.id === id);
        // Keep the input's appearance order for reference images; only the count is trimmed.
        const refEntries = [];
        const seenKeys = new Set();
        for (const id of orderedIds) {
          const person = personAt(id);
          if (!person?.lookImageKey || seenKeys.has(person.lookImageKey)) continue;
          seenKeys.add(person.lookImageKey);
          refEntries.push({ key: person.lookImageKey, castIndex: cast.indexOf(person) });
        }
        // Reserve one reference slot for the previous tail image before trimming look images.
        const lookBudget = usePrevTail ? Math.max(0, limits.maxImageRefs - 1) : limits.maxImageRefs;
        const included = refEntries.slice(0, lookBudget);
        const imageRefs = included.map(({ key }) => key);
        const droppedRefs = refEntries.length - included.length;
        const imageCharacters = included.map(({ castIndex }) => ({ handle: handleFor(castIndex), brief: briefFor(castIndex) }));
        const speakerCount = (id) => (segment.dialogue ?? []).filter((line) => {
          const speakerId = line.castId ?? cast[line.castIndex]?.id;
          return speakerId === id;
        }).length;
        const audioRefs = [];
        const audioHandles = [];
        if (voicesEnabled && segments.length > 1) {
          const ordered = orderedIds.map((id, appearance) => ({ id, appearance }))
            .sort((left, right) => speakerCount(right.id) - speakerCount(left.id) || left.appearance - right.appearance);
          const seenAudio = new Set();
          for (const { id } of ordered) {
            const person = personAt(id);
            if (!person?.refAudioKey || seenAudio.has(person.refAudioKey)) continue;
            seenAudio.add(person.refAudioKey);
            audioRefs.push(person.refAudioKey);
            audioHandles.push(handleFor(cast.indexOf(person)));
          }
        }
        const dialogueLines = (segment.dialogue ?? []).map((line) => {
          const castIndex = Number.isInteger(line?.castIndex) ? line.castIndex : cast.findIndex((person) => person.id === line?.castId);
          if (!Number.isInteger(castIndex) || castIndex < 0 || castIndex >= cast.length) {
            throw new Error(`第 ${segmentIndex + 1} 段对白说话人无法定位`);
          }
          return { castIndex, line: String(line.line) };
        });
        const scene = bible?.scenes?.find((item) => item?.id === segment.sceneId) ?? null;
        const props = (Array.isArray(segment.propIds) ? segment.propIds : [])
          .map((id) => bible?.props?.find((item) => item?.id === id)).filter(Boolean);
        const startState = usePrevTail ? String(segments[segmentIndex - 1]?.endState ?? '') : '';
        const endState = String(segment.endState ?? '');
        const takeMode = segment.takeMode === 'single_take' ? 'single_take' : 'multi_shot';
        const assembleBase = { styleText: style?.promptHint ?? style?.name ?? '',
          sceneDescription: scene?.description ?? '', propDescriptions: props.map((prop) => prop.description),
          characters: imageCharacters, audioHandles, usePrevTail, startState, durationSeconds, mood, handles: handlesMap };
        const messageText = skill.buildShotMessage({ durationSeconds, takeMode, plot: String(segment.plot ?? ''),
          startState, endState, scene, props, characters: imageCharacters,
          dialogue: dialogueLines.map((line) => ({ ...line, handle: handleFor(line.castIndex) })),
          cameraNotes: String(segment.cameraNotes ?? ''), ambience: String(segment.ambience ?? '') });
        const messages = [{ role: 'user', content: messageText }];
        let lastText;
        let accepted = null;
        for (let attempt = 0; attempt <= MAX_REPAIR_ATTEMPTS; attempt += 1) {
          throwIfCallerCancelled(signal);
          const deadline = deadlineSignal({ signal, timeoutMs });
          try {
            const response = await llm.complete({ system: skill.shotSystem({ durationSeconds, takeMode }),
              messages, signal: deadline.signal });
            lastText = response.text;
            addUsage(usage, response);
            const { shots, avoid } = skill.validateShots(parseModelJson(response.text),
              { durationSeconds, takeMode, dialogue: dialogueLines, limits });
            accepted = { ...fitPrompt(skill, assembleBase, shots, avoid, limits.maxChars) };
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
        let degraded = false;
        if (!accepted) {
          // 确定性兜底：单镜头 + 剧情直述，对白由代码嵌入（docs/skills/wan-3.0.md §7）。
          degraded = true;
          const { shots, avoid } = skill.fallbackTimeline({ durationSeconds, plot: String(segment.plot ?? ''),
            dialogue: dialogueLines });
          const prompt = skill.assemble({ ...assembleBase, shots, shotAvoids: avoid });
          accepted = { prompt, shots, avoid };
          logger?.warn?.('shot_timeline_fallback', { segmentIndex });
        }
        result.push({ segmentIndex, prompt: accepted.prompt, imageRefs, audioRefs, usePrevTail,
          droppedRefs, startState, endState, shots: accepted.shots, skillId: skill.id,
          skillVersion: skill.version, degraded });
      }
      return Object.assign(result, { usage });
    },
  };
}

export { classifyInput };

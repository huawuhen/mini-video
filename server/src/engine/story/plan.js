// Story planning constraints and deterministic fallback.
const AGE_GROUPS = ['child', 'teen', 'young', 'middle', 'elder'];
const MAX_OVERFLOW_PLOT_CHARS = 1000;
const trimText = (value, fallback = '') => typeof value === 'string' && value.trim() ? value.trim() : fallback;
const clampWords = (text, maxWords) => trimText(text).split(/\s+/).slice(0, maxWords).join(' ');

export class InsufficientVoicesError extends Error {
  constructor() {
    super('可用音色不足，无法为不同角色分配不重复的声音');
    this.name = 'InsufficientVoicesError';
  }
}

export function validateInput({ storyText, maxSeconds, allowedDurations, characters = [], voices = [] }) {
  if (typeof storyText !== 'string' || !storyText.trim() || storyText.length > 3000) throw new Error('故事应为 1~3000 字');
  if (!Number.isSafeInteger(maxSeconds) || maxSeconds <= 0 || !Array.isArray(allowedDurations)
    || !allowedDurations.length || allowedDurations.some((n) => !Number.isSafeInteger(n) || n <= 0)
    || !allowedDurations.some((n) => n <= maxSeconds)) throw new Error('时长配置不可用');
  return { storyText, maxSeconds, allowedDurations: [...new Set(allowedDurations)].sort((a, b) => b - a),
    characters: Array.isArray(characters) ? characters : [], voices: Array.isArray(voices) ? voices : [] };
}

function pickDurations(target, allowed, limit) {
  const usable = allowed.filter((n) => n <= limit);
  if (!usable.length) throw new Error('没有可用的片段时长');
  const result = [];
  let remaining = Math.min(target, limit);
  while (remaining >= usable.at(-1)) {
    const next = usable.find((n) => n <= remaining);
    if (!next) break;
    result.push(next);
    remaining -= next;
  }
  return result.length ? result : [usable.at(-1)];
}

/** Exact name match wins; a substring match only counts when exactly one character contains it. */
function matchCharacter(name, characters) {
  const exact = characters.find((item) => item.name === name);
  if (exact) return exact.id;
  const contains = characters.filter((item) => item.name && item.name !== name && name.includes(item.name));
  return contains.length === 1 ? contains[0].id : undefined;
}

/** Bind at most one cast member per characterId; later matches are treated as new characters. */
export function bindCharacters(rawCast, characters) {
  const taken = new Set();
  return rawCast.map((person) => {
    const trimmed = person.name.trim();
    const candidateId = matchCharacter(trimmed, characters);
    const character = candidateId && !taken.has(candidateId)
      ? characters.find((item) => item.id === candidateId) : undefined;
    if (character) taken.add(character.id);
    return { name: trimmed, description: trimText(person.description),
      gender: person.gender, ageGroup: person.ageGroup,
      ...(character ? { characterId: character.id, defaultVoiceId: character.defaultVoiceId } : {}) };
  });
}

function voiceFor(person, voices, used) {
  const preferred = voices.find((voice) => voice.id === person.defaultVoiceId && !used.has(voice.id));
  if (preferred) { used.add(preferred.id); return preferred.id; }
  const candidates = voices.filter((v) => v?.id && !used.has(v.id));
  const scored = candidates.map((voice) => ({ voice, score: (voice.gender === person.gender ? 4 : 0)
    + (voice.ageGroup === person.ageGroup ? 4 : 0)
    + (person.description && voice.description && person.description.includes(voice.description) ? 1 : 0) }));
  scored.sort((a, b) => b.score - a.score || String(a.voice.id).localeCompare(String(b.voice.id)));
  const chosen = scored[0]?.voice;
  if (!chosen) throw new InsufficientVoicesError();
  used.add(chosen.id);
  return chosen.id;
}

function assignVoices(cast, voices) {
  // Voices are recommendations only: when there are not enough for everyone, leave the
  // remaining cast without voiceId. BE-05's confirmation step lets the user pick one.
  const used = new Set();
  for (const person of cast) {
    const preferred = voices.find((voice) => voice.id === person.defaultVoiceId && !used.has(voice.id));
    if (preferred) { person.voiceId = preferred.id; used.add(preferred.id); }
  }
  for (const person of cast) {
    if (person.voiceId) continue;
    try { person.voiceId = voiceFor(person, voices, used); }
    catch (error) {
      if (!(error instanceof InsufficientVoicesError)) throw error;
      break; // keep the rest unassigned rather than duplicating voices
    }
  }
}

/** Clamp the bible's soft word-count limits; hard rules (English-only, unique ids/handles,
 * resolvable references) are already enforced by validatePlan before this runs. */
function normalizeBible(raw, { logger } = {}) {
  const clamped = { mood: 0, brief: 0, scene: 0, prop: 0 };
  const brief = (person) => {
    const words = trimText(person.brief).split(/\s+/);
    if (words.length > 25) clamped.brief += 1;
    return words.slice(0, 25).join(' ');
  };
  const bible = {
    mood: (() => { const words = trimText(raw.mood).split(/\s+/);
      if (words.length > 8) clamped.mood += 1;
      return words.slice(0, 8).join(' '); })(),
    characters: raw.characters.map((person) => ({ castIndex: person.castIndex, handle: trimText(person.handle), brief: brief(person) })),
    scenes: raw.scenes.map((scene) => { const words = trimText(scene.description).split(/\s+/);
      if (words.length > 50) clamped.scene += 1;
      return { id: trimText(scene.id), nameZh: trimText(scene.nameZh), description: words.slice(0, 50).join(' ') }; }),
    props: (raw.props ?? []).map((prop) => { const words = trimText(prop.description).split(/\s+/);
      if (words.length > 25) clamped.prop += 1;
      return { id: trimText(prop.id), nameZh: trimText(prop.nameZh), description: words.slice(0, 25).join(' ') }; }),
  };
  if (Object.values(clamped).some((count) => count > 0)) {
    logger?.warn?.('story_bible_clamped', clamped);
  }
  return bible;
}

export function normalizePlan(raw, input, { degraded = false, logger } = {}) {
  const allowed = input.allowedDurations;
  const smallest = allowed.at(-1);
  const cast = bindCharacters(raw.cast, input.characters);
  for (const character of input.characters.filter((item) => item.selected)) {
    if (!cast.some((person) => person.characterId === character.id)) cast.push({ name: character.name,
      description: trimText(character.description), gender: character.gender ?? 'unknown',
      ageGroup: AGE_GROUPS.includes(character.ageGroup) ? character.ageGroup : 'young', characterId: character.id,
      defaultVoiceId: character.defaultVoiceId });
  }
  const bible = normalizeBible(raw.bible, { logger });
  const propIdSet = new Set(bible.props.map((prop) => prop.id));
  const proposed = raw.segments.reduce((sum, segment) => sum + segment.durationSeconds, 0);
  let remaining = input.maxSeconds;
  const segments = [];
  let overflowPlots = [];
  for (const [index, segment] of raw.segments.entries()) {
    const requested = segment.durationSeconds;
    // Budget exhausted (remaining below the smallest allowed duration) is the only overflow.
    // A requested duration above the allowed maximum steps DOWN to the largest allowed value
    // that still fits the remaining budget; a too-short one rounds UP to the smallest.
    // Segments are never silently dropped, and any change marks the plan as compressed.
    const budget = allowed.filter((n) => n <= remaining);
    if (!budget.length) {
      overflowPlots.push(segment.plot.trim());
      continue;
    }
    const durationSeconds = requested < smallest ? smallest
      : Math.max(...budget.filter((n) => n <= requested));
    const castIndexes = [...new Set(segment.castIndexes.filter((i) => i < cast.length))];
    const sceneId = trimText(segment.sceneId);
    const propIds = [...new Set((segment.propIds ?? []).map((id) => String(id).trim()))]
      .filter((id) => propIdSet.has(id));
    segments.push({ durationSeconds, plot: segment.plot.trim(), cameraNotes: trimText(segment.cameraNotes),
      dialogue: segment.dialogue.filter((line) => line.castIndex < cast.length)
        .map((line) => ({ castIndex: line.castIndex, line: line.line.trim() })),
      ambience: trimText(segment.ambience),
      transition: index > 0 && segment.transition === 'prev_tail' && sceneId
        && sceneId === segments.at(-1)?.sceneId ? 'prev_tail' : 'hard_cut',
      sceneId,
      propIds,
      endState: clampWords(segment.endState, 50),
      takeMode: segment.takeMode === 'single_take' ? 'single_take' : 'multi_shot',
      castIndexes });
    remaining -= durationSeconds;
  }
  if (!segments.length) throw new Error('片段规划没有可用时长');
  const compressed = proposed > input.maxSeconds || overflowPlots.length > 0
    || segments.some((segment, index) => segment.durationSeconds !== raw.segments[index]?.durationSeconds);
  if (overflowPlots.length) {
    const overflow = overflowPlots.map((plot) => plot.trim()).filter(Boolean).join('；').slice(0, MAX_OVERFLOW_PLOT_CHARS);
    if (overflow) segments.at(-1).plot += `；压缩叙事：${overflow}`;
    logger?.warn?.('story_plan_compressed', { droppedSegments: overflowPlots.length });
  }
  for (const selected of input.characters.filter((item) => item.selected)) {
    const index = cast.findIndex((person) => person.characterId === selected.id);
    if (index >= 0 && !segments.some((segment) => segment.castIndexes.includes(index))) segments[0].castIndexes.push(index);
  }
  if (segments.length > 1) assignVoices(cast, input.voices);
  for (const person of cast) delete person.defaultVoiceId;
  const totalSeconds = segments.reduce((sum, segment) => sum + segment.durationSeconds, 0);
  return { title: trimText(raw.title, '我的故事'), synopsis: raw.synopsis.trim(), compressed,
    ...(compressed ? { notice: `故事较长，已为您精简为 ${totalSeconds} 秒` } : {}),
    degraded, totalSeconds, segmentCount: segments.length, bible, cast, segments };
}

export function fallbackPlan(input) {
  const words = input.storyText.trim();
  const maxAllowed = input.allowedDurations.find((n) => n <= input.maxSeconds);
  const target = Math.min(input.maxSeconds, Math.max(maxAllowed, Math.ceil(words.length / 80) * maxAllowed));
  const durations = pickDurations(target, input.allowedDurations, input.maxSeconds);
  const selected = input.characters.filter((item) => item.selected);
  const cast = selected.map((item) => ({ name: item.name,
    description: trimText(item.description), gender: item.gender ?? 'unknown', defaultVoiceId: item.defaultVoiceId,
    ageGroup: AGE_GROUPS.includes(item.ageGroup) ? item.ageGroup : 'young', characterId: item.id }));
  if (!cast.length) cast.push({ name: '主角', description: '故事中的主角', gender: 'unknown', ageGroup: 'young' });
  const synopsis = words.length < 20 ? `在温暖的日常场景中，${words}。画面补足人物的动作、表情和情绪变化。` : words.slice(0, 260);
  const bible = {
    mood: 'natural, realistic; soft warm light',
    characters: cast.map((_, index) => ({ castIndex: index, handle: `character ${index + 1}`,
      brief: 'story character, appearance follows the reference image' })),
    scenes: [{ id: 's1', nameZh: '故事场景',
      description: 'the main location where the story happens, natural daylight, realistic everyday details' }],
    props: [],
  };
  const segments = durations.map((durationSeconds, index) => ({ durationSeconds,
    plot: words.slice(Math.floor(index * words.length / durations.length), Math.floor((index + 1) * words.length / durations.length)) || words,
    cameraNotes: '从人物与环境的建立镜头推进到动作细节，最后落在情绪反应。',
    dialogue: [], ambience: '与场景一致的自然环境音。', transition: 'hard_cut',
    sceneId: 's1', propIds: [],
    endState: 'the scene settles into a calm resting state, medium shot, natural light',
    takeMode: 'multi_shot',
    castIndexes: cast.map((_, i) => i) }));
  if (segments.length > 1) assignVoices(cast, input.voices);
  for (const person of cast) delete person.defaultVoiceId;
  const totalSeconds = durations.reduce((sum, n) => sum + n, 0);
  const compressed = words.length > 300 || Math.ceil(words.length / 80) * maxAllowed > input.maxSeconds;
  return { title: words.slice(0, 16) || '我的故事', synopsis, compressed,
    ...(compressed ? { notice: `故事较长，已为您精简为 ${totalSeconds} 秒` } : {}),
    degraded: true, totalSeconds, segmentCount: segments.length, bible, cast, segments };
}

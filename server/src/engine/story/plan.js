// Story planning constraints and deterministic fallback.
const AGE_GROUPS = ['child', 'teen', 'young', 'middle', 'elder'];
const trimText = (value, fallback = '') => typeof value === 'string' && value.trim() ? value.trim() : fallback;

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

function matchCharacter(name, characters) {
  const exact = characters.find((item) => item.name === name);
  if (exact) return exact.id;
  return characters.find((item) => item.name && name.includes(item.name))?.id;
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
  const used = new Set();
  for (const person of cast) {
    const preferred = voices.find((voice) => voice.id === person.defaultVoiceId && !used.has(voice.id));
    if (preferred) { person.voiceId = preferred.id; used.add(preferred.id); }
  }
  for (const person of cast) if (!person.voiceId) person.voiceId = voiceFor(person, voices, used);
}

export function normalizePlan(raw, input, { degraded = false } = {}) {
  const allowed = input.allowedDurations;
  const cast = raw.cast.map((person) => {
    const character = input.characters.find((item) => item.id === matchCharacter(person.name.trim(), input.characters));
    return { name: person.name.trim(), description: trimText(person.description),
      gender: person.gender, ageGroup: person.ageGroup,
      ...(character ? { characterId: character.id, defaultVoiceId: character.defaultVoiceId } : {}) };
  });
  for (const character of input.characters.filter((item) => item.selected)) {
    if (!cast.some((person) => person.characterId === character.id)) cast.push({ name: character.name,
      description: trimText(character.description), gender: character.gender ?? 'unknown',
      ageGroup: AGE_GROUPS.includes(character.ageGroup) ? character.ageGroup : 'young', characterId: character.id,
      defaultVoiceId: character.defaultVoiceId });
  }
  const proposed = raw.segments.reduce((sum, segment) => sum + segment.durationSeconds, 0);
  let remaining = input.maxSeconds;
  const segments = [];
  for (const [index, segment] of raw.segments.entries()) {
    const durationSeconds = allowed.includes(segment.durationSeconds) && segment.durationSeconds <= remaining
      ? segment.durationSeconds : allowed.find((n) => n <= remaining && n <= segment.durationSeconds);
    if (!durationSeconds) break;
    const castIndexes = [...new Set(segment.castIndexes.filter((i) => i < cast.length))];
    const sceneId = trimText(segment.sceneId);
    segments.push({ durationSeconds, plot: segment.plot.trim(), cameraNotes: trimText(segment.cameraNotes),
      dialogue: segment.dialogue.filter((line) => line.castIndex < cast.length)
        .map((line) => ({ castIndex: line.castIndex, line: line.line.trim() })),
      ambience: trimText(segment.ambience),
      transition: index > 0 && segment.transition === 'prev_tail' && sceneId
        && sceneId === segments.at(-1).sceneId ? 'prev_tail' : 'hard_cut',
      sceneId, castIndexes });
    remaining -= durationSeconds;
  }
  if (!segments.length) throw new Error('片段规划没有可用时长');
  if (segments.length < raw.segments.length) {
    const overflow = raw.segments.slice(segments.length).map((segment) => segment.plot.trim()).filter(Boolean).join('；');
    segments.at(-1).plot += `；压缩叙事：${overflow}`;
  }
  for (const selected of input.characters.filter((item) => item.selected)) {
    const index = cast.findIndex((person) => person.characterId === selected.id);
    if (index >= 0 && !segments.some((segment) => segment.castIndexes.includes(index))) segments[0].castIndexes.push(index);
  }
  if (segments.length > 1) assignVoices(cast, input.voices);
  for (const person of cast) delete person.defaultVoiceId;
  for (const segment of segments) delete segment.sceneId;
  const totalSeconds = segments.reduce((sum, segment) => sum + segment.durationSeconds, 0);
  const compressed = proposed > totalSeconds || segments.length < raw.segments.length;
  return { title: trimText(raw.title, '我的故事'), synopsis: raw.synopsis.trim(), compressed,
    ...(compressed ? { notice: `故事较长，已为您精简为 ${totalSeconds} 秒` } : {}),
    degraded, totalSeconds, segmentCount: segments.length, cast, segments };
}

export function fallbackPlan(input) {
  const words = input.storyText.trim();
  const maxAllowed = input.allowedDurations.find((n) => n <= input.maxSeconds);
  const target = Math.min(input.maxSeconds, Math.max(maxAllowed, Math.ceil(words.length / 80) * maxAllowed));
  const durations = pickDurations(target, input.allowedDurations, input.maxSeconds);
  const cast = input.characters.filter((item) => item.selected).map((item) => ({ name: item.name,
    description: trimText(item.description), gender: item.gender ?? 'unknown', defaultVoiceId: item.defaultVoiceId,
    ageGroup: AGE_GROUPS.includes(item.ageGroup) ? item.ageGroup : 'young', characterId: item.id }));
  const synopsis = words.length < 20 ? `在温暖的日常场景中，${words}。画面补足人物的动作、表情和情绪变化。` : words.slice(0, 260);
  const segments = durations.map((durationSeconds, index) => ({ durationSeconds,
    plot: words.slice(Math.floor(index * words.length / durations.length), Math.floor((index + 1) * words.length / durations.length)) || words,
    cameraNotes: '从人物与环境的建立镜头推进到动作细节，最后落在情绪反应。',
    dialogue: [], ambience: '与场景一致的自然环境音。', transition: index ? 'hard_cut' : 'hard_cut',
    castIndexes: cast.map((_, i) => i) }));
  if (segments.length > 1) assignVoices(cast, input.voices);
  const totalSeconds = durations.reduce((sum, n) => sum + n, 0);
  for (const person of cast) delete person.defaultVoiceId;
  const compressed = words.length > 300 || Math.ceil(words.length / 80) * maxAllowed > input.maxSeconds;
  return { title: words.slice(0, 16) || '我的故事', synopsis, compressed,
    ...(compressed ? { notice: `故事较长，已为您精简为 ${totalSeconds} 秒` } : {}),
    degraded: true, totalSeconds, segmentCount: segments.length, cast, segments };
}

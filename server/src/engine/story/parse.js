// Source: chaodayun@2926b42 backend/screenwriter/index.js (adapted: bounded JSON parsing,
// strict story validation incl. the story bible, finite repair, deterministic fallback).
const MAX_RESPONSE_CHARS = 200_000;
// English-only fields (bible text, endState) must not contain CJK ideographs/kana or
// fullwidth/CJK punctuation; dialogue and nameZh stay Chinese.
const NON_LATIN_RE = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;
const TAKE_MODES = ['multi_shot', 'single_take'];

export function parseModelJson(text) {
  if (typeof text !== 'string' || text.length > MAX_RESPONSE_CHARS) throw new Error('模型输出超过解析上限');
  const trimmed = text.trim();
  const fence = trimmed.startsWith('```') ? trimmed.indexOf('\n') : -1;
  const source = fence >= 0 ? trimmed.slice(fence + 1, trimmed.lastIndexOf('```') > fence ? trimmed.lastIndexOf('```') : undefined) : trimmed;
  const first = source.indexOf('{');
  if (first < 0) throw new Error('模型输出没有 JSON 对象');
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let end = -1;
  for (let i = first; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}' && --depth === 0) { end = i + 1; break; }
  }
  if (end < 0) throw new Error('模型输出 JSON 未闭合');
  const body = source.slice(first, end);
  try { return JSON.parse(body); }
  catch {
    // Remove trailing commas outside strings in one pass; do not use nested regular expressions.
    let clean = '';
    quoted = false;
    escaped = false;
    for (let i = 0; i < body.length; i += 1) {
      const ch = body[i];
      if (quoted) {
        clean += ch;
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') quoted = false;
      } else if (ch === '"') { quoted = true; clean += ch; }
      else if (ch === ',') {
        let j = i + 1;
        while (j < body.length && /\s/.test(body[j])) j += 1;
        if (body[j] !== '}' && body[j] !== ']') clean += ch;
      } else clean += ch;
    }
    return JSON.parse(clean);
  }
}

const latinText = (value, label) => {
  if (typeof value !== 'string' || !value.trim() || NON_LATIN_RE.test(value)) {
    throw new Error(`${label}必须是非空英文`);
  }
  return value;
};

function validateBible(raw, castLength) {
  const bible = raw.bible;
  if (!bible || typeof bible !== 'object' || Array.isArray(bible)) throw new Error('缺少设定集 bible');
  latinText(bible.mood, 'bible.mood');
  if (!Array.isArray(bible.characters) || !bible.characters.length) throw new Error('bible.characters 不能为空');
  const handles = new Set();
  for (const person of bible.characters) {
    if (!person || !Number.isInteger(person.castIndex) || person.castIndex < 0 || person.castIndex >= castLength) {
      throw new Error('bible.characters[].castIndex 必须是 cast 数组下标');
    }
    const handle = latinText(person.handle, 'bible handle');
    if (handles.has(handle)) throw new Error(`bible handle 重复：${handle}`);
    handles.add(handle);
    latinText(person.brief, 'bible brief');
  }
  if (!Array.isArray(bible.scenes) || !bible.scenes.length) throw new Error('bible.scenes 不能为空');
  const sceneIds = new Set();
  for (const scene of bible.scenes) {
    if (!scene || typeof scene.id !== 'string' || !scene.id.trim() || sceneIds.has(scene.id.trim())) {
      throw new Error('bible.scenes[].id 必须唯一且非空');
    }
    sceneIds.add(scene.id.trim());
    if (typeof scene.nameZh !== 'string' || !scene.nameZh.trim()) throw new Error('bible.scenes[].nameZh 必须是非空中文');
    latinText(scene.description, 'bible 场景 description');
  }
  if (bible.props !== undefined && !Array.isArray(bible.props)) throw new Error('bible.props 必须是数组');
  const propIds = new Set();
  for (const prop of bible.props ?? []) {
    if (!prop || typeof prop.id !== 'string' || !prop.id.trim() || propIds.has(prop.id.trim())) {
      throw new Error('bible.props[].id 必须唯一且非空');
    }
    propIds.add(prop.id.trim());
    if (typeof prop.nameZh !== 'string' || !prop.nameZh.trim()) throw new Error('bible.props[].nameZh 必须是非空中文');
    latinText(prop.description, 'bible 道具 description');
  }
  return { sceneIds, propIds };
}

export function validatePlan(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('计划必须是对象');
  if (typeof raw.synopsis !== 'string' || !raw.synopsis.trim()) throw new Error('synopsis 必须是非空文字');
  if (!Array.isArray(raw.cast) || !Array.isArray(raw.segments) || !raw.segments.length) {
    throw new Error('cast 与 segments 必须是数组且至少有一个片段');
  }
  for (const person of raw.cast) {
    if (!person || typeof person.name !== 'string' || !person.name.trim()
      || !['female', 'male', 'unknown'].includes(person.gender)
      || !['child', 'teen', 'young', 'middle', 'elder'].includes(person.ageGroup)) {
      throw new Error('角色缺少姓名、性别或年龄段');
    }
  }
  const { sceneIds, propIds } = validateBible(raw, raw.cast.length);
  for (const segment of raw.segments) {
    if (!segment || !Number.isInteger(segment.durationSeconds) || segment.durationSeconds <= 0
      || typeof segment.plot !== 'string' || !segment.plot.trim()
      || !['prev_tail', 'hard_cut'].includes(segment.transition)
      || !Array.isArray(segment.dialogue) || !Array.isArray(segment.castIndexes)) {
      throw new Error('片段缺少合法时长、剧情、转场或角色');
    }
    if (segment.castIndexes.some((index) => !Number.isInteger(index) || index < 0 || index >= raw.cast.length)
      || segment.dialogue.some((line) => !Number.isInteger(line?.castIndex) || line.castIndex < 0
        || line.castIndex >= raw.cast.length || typeof line.line !== 'string')) {
      throw new Error('片段角色索引或对白无效');
    }
    if (typeof segment.sceneId !== 'string' || !segment.sceneId.trim() || !sceneIds.has(segment.sceneId.trim())) {
      throw new Error('片段 sceneId 必须引用 bible.scenes 中的 id');
    }
    if (segment.propIds !== undefined) {
      if (!Array.isArray(segment.propIds)
        || segment.propIds.some((id) => !propIds.has(String(id).trim()))) {
        throw new Error('片段 propIds 必须引用 bible.props 中的 id');
      }
    }
    latinText(segment.endState, '片段 endState');
    if (segment.takeMode !== undefined && !TAKE_MODES.includes(segment.takeMode)) {
      throw new Error('takeMode 只能是 multi_shot 或 single_take');
    }
  }
  return raw;
}

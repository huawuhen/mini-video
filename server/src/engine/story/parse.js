// Source: chaodayun@2926b42 backend/screenwriter/index.js (adapted: bounded JSON parsing,
// strict story validation, finite repair, deterministic fallback; no repository/session dependencies).
const MAX_RESPONSE_CHARS = 200_000;

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
  }
  return raw;
}

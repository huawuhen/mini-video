// Source: chaodayun@2926b42 backend/screenwriter/extract.js
// Adapted to bounded, asynchronous ZIP extraction without a third-party parser.
import { inflateRaw } from 'node:zlib';
import { promisify } from 'node:util';

const inflateRawAsync = promisify(inflateRaw);
const MAX_DOCX_XML_BYTES = 5 * 1024 * 1024; // 5MB XML 已远大于允许上传的 2MB 剧本文本

export class ExtractError extends Error {
  constructor(message, code = 'EXTRACT_INVALID') {
    super(message);
    this.name = 'ExtractError';
    this.code = code;
  }
}

const isZip = (buffer) => buffer.length >= 4 && buffer.readUInt32LE(0) === 0x04034b50;
const hasRange = (buffer, offset, length) => Number.isSafeInteger(offset) && Number.isSafeInteger(length)
  && offset >= 0 && length >= 0 && offset <= buffer.length - length;

async function readZipEntry(buffer, wantedName) {
  try {
    let eocd = -1;
    for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 65_535); i -= 1) {
      if (buffer.readUInt32LE(i) === 0x06054b50 && hasRange(buffer, i, 22 + buffer.readUInt16LE(i + 20))) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0 || buffer.readUInt16LE(eocd + 4) !== 0 || buffer.readUInt16LE(eocd + 6) !== 0) {
      throw new ExtractError('不是有效的 Word 文档。');
    }
    const count = buffer.readUInt16LE(eocd + 10);
    const directorySize = buffer.readUInt32LE(eocd + 12);
    let offset = buffer.readUInt32LE(eocd + 16);
    if (count === 0xffff || directorySize === 0xffffffff || offset === 0xffffffff
      || !hasRange(buffer, offset, directorySize) || offset + directorySize > eocd) {
      throw new ExtractError('Word 文档目录损坏。');
    }
    const directoryEnd = offset + directorySize;
    for (let i = 0; i < count; i += 1) {
      if (!hasRange(buffer, offset, 46) || offset + 46 > directoryEnd || buffer.readUInt32LE(offset) !== 0x02014b50) {
        throw new ExtractError('Word 文档目录损坏。');
      }
      const flags = buffer.readUInt16LE(offset + 8);
      const method = buffer.readUInt16LE(offset + 10);
      const compressedSize = buffer.readUInt32LE(offset + 20);
      const uncompressedSize = buffer.readUInt32LE(offset + 24);
      const nameLength = buffer.readUInt16LE(offset + 28);
      const extraLength = buffer.readUInt16LE(offset + 30);
      const commentLength = buffer.readUInt16LE(offset + 32);
      const localOffset = buffer.readUInt32LE(offset + 42);
      const next = offset + 46 + nameLength + extraLength + commentLength;
      if (!hasRange(buffer, offset, next - offset) || next > directoryEnd) throw new ExtractError('Word 文档目录损坏。');
      const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
      offset = next;
      if (name !== wantedName) continue;
      if (uncompressedSize > MAX_DOCX_XML_BYTES) {
        throw new ExtractError('文档解压后过大，已拒绝处理。', 'EXTRACT_TOO_LARGE');
      }
      if (flags & 1 || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff
        || !hasRange(buffer, localOffset, 30) || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
        throw new ExtractError('Word 文档正文损坏。');
      }
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      if (!hasRange(buffer, start, compressedSize) || start + compressedSize > offset - (46 + nameLength + extraLength + commentLength)) {
        throw new ExtractError('Word 文档正文损坏。');
      }
      const compressed = buffer.subarray(start, start + compressedSize);
      let xml;
      if (method === 0) xml = Buffer.from(compressed);
      else if (method === 8) {
        try {
          xml = await inflateRawAsync(compressed, { maxOutputLength: MAX_DOCX_XML_BYTES });
        } catch (error) {
          if (error?.code === 'ERR_BUFFER_TOO_LARGE') {
            throw new ExtractError('文档解压后过大，已拒绝处理。', 'EXTRACT_TOO_LARGE');
          }
          throw new ExtractError('Word 文档解压失败。');
        }
      } else throw new ExtractError('Word 文档使用了不支持的压缩方式。');
      if (xml.length !== uncompressedSize) throw new ExtractError('Word 文档正文长度不符。');
      return xml;
    }
    throw new ExtractError('文档缺少正文。');
  } catch (error) {
    if (error instanceof ExtractError) throw error;
    throw new ExtractError('Word 文档解析失败。');
  }
}

function decodeCodePoint(raw, digits, radix) {
  const code = Number.parseInt(digits, radix);
  if (!Number.isSafeInteger(code) || code < 1 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return raw;
  return String.fromCodePoint(code);
}

function decodeEntities(value) {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#x[0-9a-f]+|#\d+);/gi, (entity) => {
    const named = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
    const lower = entity.toLowerCase();
    if (Object.hasOwn(named, lower)) return named[lower];
    if (lower.startsWith('&#x')) return decodeCodePoint(entity, lower.slice(3, -1), 16);
    return decodeCodePoint(entity, lower.slice(2, -1), 10);
  });
}

function tagAt(xml, start) {
  const end = xml.indexOf('>', start + 1);
  if (end < 0) throw new ExtractError('Word 文档正文标签未闭合。');
  let nameStart = start + 1;
  const closing = xml[nameStart] === '/';
  if (closing) nameStart += 1;
  let nameEnd = nameStart;
  while (nameEnd < end && xml[nameEnd] !== '/' && !/\s/.test(xml[nameEnd])) nameEnd += 1;
  let last = end - 1;
  while (last > nameEnd && /\s/.test(xml[last])) last -= 1;
  return { name: xml.slice(nameStart, nameEnd), closing, selfClosing: xml[last] === '/', end };
}

async function extractDocx(buffer) {
  const xml = new TextDecoder('utf-8', { fatal: true }).decode(await readZipEntry(buffer, 'word/document.xml'));
  const paragraphs = [];
  const stack = [];
  const alternatives = [];
  let index = 0;
  while (index < xml.length) {
    const open = xml.indexOf('<', index);
    if (open < 0) break;
    const tag = tagAt(xml, open);
    index = tag.end + 1;
    if (tag.name === 'mc:AlternateContent') {
      if (tag.closing) alternatives.pop();
      else alternatives.push({ choiceSeen: false });
      continue;
    }
    if (tag.name === 'mc:Choice' && !tag.closing && alternatives.length) {
      alternatives.at(-1).choiceSeen = true;
    }
    if (tag.name === 'mc:Fallback' && !tag.closing && alternatives.at(-1)?.choiceSeen) {
      const end = xml.indexOf('</mc:Fallback>', index);
      if (end < 0) throw new ExtractError('Word 文档文本框标签未闭合。');
      index = end + '</mc:Fallback>'.length;
      continue;
    }
    if (tag.name === 'w:p') {
      if (tag.closing) {
        if (!stack.length) throw new ExtractError('Word 文档段落标签未闭合。');
        paragraphs.push(stack.pop().join(''));
      } else if (tag.selfClosing) paragraphs.push('');
      else stack.push([]);
    } else if (stack.length && !tag.closing && tag.name === 'w:t') {
      if (tag.selfClosing) continue;
      const textEnd = xml.indexOf('<', index);
      if (textEnd < 0) throw new ExtractError('Word 文档正文标签未闭合。');
      const closing = tagAt(xml, textEnd);
      if (!closing.closing || closing.name !== 'w:t') throw new ExtractError('Word 文档正文标签未闭合。');
      stack.at(-1).push(decodeEntities(xml.slice(index, textEnd)));
      index = closing.end + 1;
    } else if (stack.length && !tag.closing && tag.name === 'w:br') stack.at(-1).push('\n');
    else if (stack.length && !tag.closing && tag.name === 'w:tab') stack.at(-1).push(' ');
  }
  if (stack.length) throw new ExtractError('Word 文档段落标签未闭合。');
  const text = paragraphs.join('\n').replace(/\r\n/g, '\n').replace(/\n{2,}/g, '\n').trim();
  if (!text) throw new ExtractError('文档中没有可提取的文字。', 'EXTRACT_EMPTY');
  return text;
}

function extractTxt(buffer) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    text = new TextDecoder('gbk', { fatal: true }).decode(buffer);
  }
  text = text.replace(/^\uFEFF/, '').trim();
  if (!text) throw new ExtractError('文件内容是空的。', 'EXTRACT_EMPTY');
  return text;
}

export async function extractText(buffer, _mime) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new ExtractError('文件内容为空。', 'EXTRACT_EMPTY');
  try {
    if (isZip(buffer)) return await extractDocx(buffer);
    if (buffer.subarray(0, 4).toString('hex') === 'd0cf11e0') {
      throw new ExtractError('这是老式 .doc 格式，请另存为 .docx 后重新上传。', 'EXTRACT_LEGACY_DOC');
    }
    if (buffer.includes(0)) throw new ExtractError('不是文本文件。');
    return extractTxt(buffer);
  } catch (error) {
    if (error instanceof ExtractError) throw error;
    throw new ExtractError('文件编码或内容无效。');
  }
}

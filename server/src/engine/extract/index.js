// Source: chaodayun@2926b42 backend/screenwriter/extract.js（适配：
//   mammoth → 零依赖解 ZIP（EOCD + central directory 定位 word/document.xml，node:zlib inflateRaw 解压）
//   再抽取 <w:t> 文本；txt 保持 UTF-8 去 BOM。不引入任何第三方依赖，文件头判断优先于扩展名/mime）。
import { inflateRawSync } from 'node:zlib';

export class ExtractError extends Error {
  constructor(message, code = 'EXTRACT_FAILED') {
    super(message);
    this.name = 'ExtractError';
    this.code = code; // EXTRACT_EMPTY / EXTRACT_INVALID / EXTRACT_LEGACY_DOC
  }
}

const isZip = (buffer) => buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04;

/**
 * 从 ZIP（docx）里读出指定路径的解压内容。
 * 只依赖 node:zlib：解析 EOCD → central directory → 本地文件头，method 8 用 inflateRaw，method 0 原样返回。
 */
function readZipEntry(buffer, wantedName) {
  // EOCD：从尾部向前找 0x06054b50（注释区最长 65535 字节）
  const searchStart = Math.max(0, buffer.length - 22 - 65_536);
  let eocd = -1;
  for (let i = Math.max(0, buffer.length - 22); i >= searchStart; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ExtractError('不是有效的 ZIP 文档。', 'EXTRACT_INVALID');
  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16); // central directory 起始偏移
  for (let i = 0; i < entryCount; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new ExtractError('ZIP 目录损坏。', 'EXTRACT_INVALID');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (name === wantedName) {
      // 本地文件头：0x04034b50，真实数据偏移要按本地头的文件名/扩展字段长度重算
      if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new ExtractError('ZIP 本地头损坏。', 'EXTRACT_INVALID');
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const raw = buffer.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) return Buffer.from(raw);
      if (method === 8) return inflateRawSync(raw);
      throw new ExtractError('文档使用了不支持的压缩方式。', 'EXTRACT_INVALID');
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new ExtractError('文档缺少正文（word/document.xml）。', 'EXTRACT_INVALID');
}

const decodeEntities = (text) => text
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
  .replace(/&amp;/g, '&');

function extractDocx(buffer) {
  const xml = readZipEntry(buffer, 'word/document.xml').toString('utf8');
  // 按段落切分（<w:p …>…</w:p>），段内合并全部 <w:t> 文本节点；标签间空白与属性不进入正文
  const paragraphs = [...xml.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>|<w:p\/>/g)].map((m) =>
    decodeEntities([...m[0].matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((t) => t[1]).join('')));
  const text = paragraphs.join('\n').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) throw new ExtractError('文档中没有可提取的文字。', 'EXTRACT_EMPTY');
  return text;
}

function extractTxt(buffer) {
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '').trim();
  if (!text) throw new ExtractError('文件内容是空的。', 'EXTRACT_EMPTY');
  return text;
}

/**
 * extractText(buffer, mime)：txt（UTF-8 去 BOM）与 docx（解 ZIP 读 word/document.xml）。
 * 判断以文件头为准（PK\x03\x04 = OOXML ZIP），mime 只作参考；老式二进制 .doc（OLE2）明确拒绝。
 */
export async function extractText(buffer, mime) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new ExtractError('文件内容为空。', 'EXTRACT_EMPTY');
  if (isZip(buffer)) return extractDocx(buffer); // 文件头优先于 mime（docstring 约定）
  if (buffer.subarray(0, 4).toString('hex').toUpperCase() === 'D0CF11E0') {
    throw new ExtractError('这是老式 .doc 格式，请另存为 .docx 后重新上传。', 'EXTRACT_LEGACY_DOC');
  }
  if (buffer.includes(0)) throw new ExtractError('不是文本文件。', 'EXTRACT_INVALID');
  return extractTxt(buffer);
}

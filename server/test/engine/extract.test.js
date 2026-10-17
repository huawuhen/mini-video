import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { describe, test } from 'node:test';
import { extractText } from '../../src/engine/extract/index.js';

/** 手工拼一个最小 ZIP（本地文件头 + central directory + EOCD），用于 docx 提取测试，无需打包器依赖。 */
function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const compressed = deflateRawSync(data);
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 flag
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    localParts.push(local, nameBuf, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);
    offset += 30 + nameBuf.length + compressed.length;
  }
  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralBuf, eocd]);
}

const DOCX_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>第一段：小猫钓鱼。</w:t></w:r></w:p>
    <w:p><w:r><w:t>第二段：&amp;&lt;特殊字符&gt;</w:t><w:t>同段续写</w:t></w:r></w:p>
  </w:body>
</w:document>`;

const DOCX = buildZip([
  { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
  { name: 'word/document.xml', data: Buffer.from(DOCX_XML) },
]);

describe('engine/extract（M1-ENG-03）', () => {
  test('txt：UTF-8 去 BOM、去首尾空白', async () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('  从前有一只小猫。\n')]);
    assert.equal(await extractText(withBom, 'text/plain'), '从前有一只小猫。');
  });

  test('空文件、二进制、老式 .doc 各自明确报错', async () => {
    await assert.rejects(() => extractText(Buffer.alloc(0), 'text/plain'), /EXTRACT_EMPTY|内容为空/);
    await assert.rejects(() => extractText(Buffer.from([0x00, 0x01, 0x02]), 'application/octet-stream'), /不是文本文件/);
    await assert.rejects(() => extractText(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), 'application/msword'), /老式 \.doc/);
  });

  test('docx：解 ZIP 读 word/document.xml，段落换行、实体解码、同段多 run 合并', async () => {
    const text = await extractText(DOCX, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    assert.ok(text.includes('第一段：小猫钓鱼。'));
    assert.ok(text.includes('第二段：&<特殊字符>同段续写'));
    const lines = text.split('\n').filter(Boolean);
    assert.deepEqual(lines, ['第一段：小猫钓鱼。', '第二段：&<特殊字符>同段续写']);
  });

  test('损坏的 ZIP 报 EXTRACT_INVALID；无正文的 docx 报 EXTRACT_EMPTY', async () => {
    await assert.rejects(
      () => extractText(Buffer.from('PK\x03\x04 not really a zip'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
      (err) => err.code === 'EXTRACT_INVALID',
    );
    const emptyDoc = buildZip([
      { name: 'word/document.xml', data: Buffer.from('<w:document><w:body></w:body></w:document>') },
    ]);
    await assert.rejects(
      () => extractText(emptyDoc, 'mime'),
      (err) => err.code === 'EXTRACT_EMPTY',
    );
  });

  test('签名与 app.js 注入点一致：返回 Promise<string>', async () => {
    const result = extractText(Buffer.from('x'), 'text/plain');
    assert.equal(typeof result.then, 'function');
    assert.equal(typeof await result, 'string');
  });

  test('压缩炸弹：中央目录声明值与伪造声明后的解压上限均拒绝', async () => {
    const huge = Buffer.alloc(21 * 1024 * 1024, 0x61);
    const archive = buildZip([{ name: 'word/document.xml', data: huge }]);
    await assert.rejects(() => extractText(archive, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
      (error) => error.code === 'EXTRACT_TOO_LARGE');
    const forged = Buffer.from(archive);
    const central = forged.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    forged.writeUInt32LE(1024, central + 24);
    await assert.rejects(() => extractText(forged, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
      (error) => ['EXTRACT_TOO_LARGE', 'EXTRACT_INVALID'].includes(error.code));
  });

  test('损坏偏移、截断 ZIP 及非法实体都不会抛裸异常', async () => {
    const corrupt = Buffer.from(DOCX);
    const central = corrupt.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    corrupt.writeUInt32LE(0xfffffff0, central + 42);
    await assert.rejects(() => extractText(corrupt, 'application/zip'), (error) => error.code === 'EXTRACT_INVALID');
    await assert.rejects(() => extractText(DOCX.subarray(0, 35), 'application/zip'),
      (error) => error.code === 'EXTRACT_INVALID');
    const entities = buildZip([{ name: 'word/document.xml',
      data: Buffer.from('<w:p><w:r><w:t>中&#x4e2d;&#99999999;文</w:t></w:r></w:p>') }]);
    assert.equal(await extractText(entities, 'application/zip'), '中中&#99999999;文');
  });

  test('txt 严格 UTF-8 解码失败后 GBK 兜底', async () => {
    assert.equal(await extractText(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), 'text/plain'), '中文');
  });
});

// 上传路由（docs/API.md §4；CODEX_HANDOFF §6 M1-BE-04 要点 a）。
// busboy 流式解析：校验文件头（不信扩展名与 Content-Type）、超限立即中断；
// docx 文本提取属于 M1-ENG-03，这里只通过注入的 extractText 调用，未注入时返回 UPLOAD_TYPE_INVALID。
import busboy from 'busboy';
import { Router } from 'express';
import { requireAuth } from '../auth/session.js';
import { newId } from '../db/ids.js';
import { appError } from '../http/errors.js';
import { asyncHandler } from '../http/middleware.js';

const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const STORY_MAX_BYTES = 2 * 1024 * 1024;

/** 读取 multipart 里的第一个文件；超过 maxBytes 立即中断并抛 UPLOAD_TOO_LARGE。 */
function readSingleFile(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, file) => {
      if (settled) return;
      settled = true;
      if (err) {
        req.resume(); // 排干剩余请求体，连接正常关闭
        reject(err);
      } else {
        resolve(file);
      }
    };
    const bb = busboy({ headers: req.headers, defParamCharset: 'utf8', limits: { files: 1, fileSize: maxBytes } });
    bb.on('file', (_name, stream, info) => {
      const chunks = [];
      let size = 0;
      stream.on('data', (chunk) => { chunks.push(chunk); size += chunk.length; });
      stream.on('limit', () => finish(appError('UPLOAD_TOO_LARGE')));
      stream.on('end', () => finish(null, { buffer: Buffer.concat(chunks), size, filename: info.filename ?? '' }));
    });
    bb.on('error', () => finish(appError('UPLOAD_TYPE_INVALID', '文件上传失败，请重试')));
    bb.on('finish', () => finish(appError('VALIDATION_FAILED', undefined, { fields: { file: '必填' } })));
    req.pipe(bb);
  });
}

/** 文件头识别（要点 a：不信扩展名和 Content-Type）。 */
function detectImageMime(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

const storyTitle = (filename) => (filename || '我的故事').replace(/\.[a-zA-Z0-9]+$/, '').trim() || '我的故事';

export function uploadRoutes({ config, db, logger, storage, urlFor, extractText }) {
  const router = Router();

  router.post('/uploads/image', requireAuth, asyncHandler(async (req, res) => {
    const file = await readSingleFile(req, IMAGE_MAX_BYTES);
    const mime = detectImageMime(file.buffer);
    if (!mime) throw appError('UPLOAD_TYPE_INVALID');

    // 未引用图片按用户限量（要点 a：防止刷存储）。§6 审查 5：检查与插入非原子，并发可略超上限，属可接受的软限制
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM uploads WHERE user_id = $1 AND referenced_at IS NULL`,
      [req.user.id],
    );
    if (rows[0].n >= config.uploads.maxUnreferencedPerUser) {
      throw appError('RATE_LIMITED', '上传的图片太多了，请稍后再试');
    }

    const uploadId = newId('upl');
    const key = `users/${req.user.id}/uploads/${uploadId}`;
    await storage.put(key, file.buffer, { contentType: mime });
    await db.query(
      `INSERT INTO uploads (id, user_id, kind, storage_key, mime, size_bytes) VALUES ($1, $2, 'image', $3, $4, $5)`,
      [uploadId, req.user.id, key, mime, file.size],
    );
    logger.info('upload_image', { uploadId, size: file.size, mime });
    const url = urlFor(key);
    res.json(url ? { uploadId, url } : { uploadId });
  }));

  router.post('/uploads/story', requireAuth, asyncHandler(async (req, res) => {
    const file = await readSingleFile(req, STORY_MAX_BYTES);
    let text;
    if (file.buffer.subarray(0, 2).toString('latin1') === 'PK') {
      // docx（ZIP 容器）：提取逻辑在 engine（M1-ENG-03），未注入则明确不支持
      if (!extractText) throw appError('UPLOAD_TYPE_INVALID', '暂不支持 Word 文档，请粘贴文字或上传 txt 文件');
      text = await extractText(file.buffer, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    } else {
      text = file.buffer.toString('utf8').replace(/^\uFEFF/, ''); // 去 BOM
    }
    text = (text ?? '').trim();
    if (!text) throw appError('VALIDATION_FAILED', '文件内容是空的，请检查后重新上传');
    logger.info('upload_story', { size: file.size, chars: text.length });
    res.json({ title: storyTitle(file.filename), text });
  }));

  return router;
}

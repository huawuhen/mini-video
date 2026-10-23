// 图片字节嗅探：不信任上游 content-type 与 URL 扩展名，按文件头判定格式。
// 用途：① 形象图落盘 key 的扩展名（aiide 素材库按 URL 扩展名校验，缺扩展名直接 400）；
//      ② gpt-image-2 的 b64_json 结果没有 content-type，需要自行判定。
const SNIFFERS = [
  { test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47, contentType: 'image/png', extension: 'png' },
  { test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff, contentType: 'image/jpeg', extension: 'jpg' },
  { test: (b) => b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP', contentType: 'image/webp', extension: 'webp' },
  { test: (b) => ['GIF87a', 'GIF89a'].includes(b.toString('ascii', 0, 6)), contentType: 'image/gif', extension: 'gif' },
];

const BY_CONTENT_TYPE = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

/** @returns {{ contentType: string, extension: string } | null} 识别不出返回 null */
export function sniffImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  const hit = SNIFFERS.find((sniffer) => sniffer.test(buffer));
  return hit ? { contentType: hit.contentType, extension: hit.extension } : null;
}

/** 扩展名判定顺序：文件头 → content-type → 缺省 png。 */
export function imageExtensionFor({ buffer, contentType } = {}) {
  const sniffed = sniffImage(buffer);
  if (sniffed) return sniffed.extension;
  const normalized = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  return BY_CONTENT_TYPE[normalized] ?? 'png';
}

/** 给存储 key 补/换图片扩展名：`users/u/looks/lkv_1` → `users/u/looks/lkv_1.png`；已是同扩展名则原样返回。 */
export function withImageExtension(key, extension) {
  const ext = String(extension ?? 'png').replace(/^\./, '').toLowerCase();
  const base = String(key).replace(/\.(png|jpe?g|webp|gif)$/i, '');
  return `${base}.${ext}`;
}

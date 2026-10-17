// Source: chaodayun@2926b42 backend/video-transfer.js（大幅简化适配：
//   去掉分段并行下载、媒体代理、临时文件与状态机；只保留「经 net 安全下载并流式写入对象存储」。
//   上游临时链接 → net.safeFetch（SSRF/大小/超时防护）→ storage.put 流式上传）。
export function createTransfer({ safeFetch, storage }) {
  /**
   * transferFromUrl(url, key, { maxBytes, timeoutMs, contentType })
   * 把上游临时链接的对象转存到存储；返回 { key, contentType }。
   * 下载与上传全流式，不落盘；失败时中断下载流。
   */
  return async function transferFromUrl(url, key, { maxBytes, timeoutMs, contentType } = {}) {
    const remote = await safeFetch(url, { maxBytes, timeoutMs });
    try {
      const resolved = contentType ?? (remote.contentType || 'application/octet-stream');
      await storage.put(key, remote.stream, { contentType: resolved });
      return { key, contentType: resolved };
    } catch (err) {
      remote.stream.destroy?.(err);
      throw err;
    }
  };
}

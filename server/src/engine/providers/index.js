// 驱动框架入口（docs/ARCHITECTURE.md §5.5）：契约、共用 HTTP 层、注册表。
// 具体协议实现在 drivers/<协议>/ 目录（自带夹具、契约测试与 README）；
// 业务代码只经渠道路由层（server/src/channels/）使用驱动实例，不直接 import 任何驱动。
export { ProviderError, assertDriverExport, assertDriverInstance, CHANNEL_KINDS } from './contract.js';
export { createChannelHttp, parseBaseUrl } from './transport.js';
export { loadDriverRegistry, createDriverRegistry, DRIVERS_DIR } from './registry.js';
export { sniffImage, imageExtensionFor, withImageExtension } from './image-bytes.js';

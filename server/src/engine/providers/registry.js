// 驱动注册表（docs/ARCHITECTURE.md §5.5）：启动时扫描 drivers/*/index.js 自动注册并校验导出形状。
// 新增协议 = 新增一个 drivers/<协议>/ 目录，其余代码不动；删驱动 = 删目录。
// 渠道记录指向不存在的驱动时，registry.create 抛 DRIVER_MISSING 类错误，由渠道路由层
// 标记该渠道「不可用」并跳过（在途任务保持原状，不退款不重提）——不在本层兜底。
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertDriverExport, assertDriverInstance, ProviderError } from './contract.js';

export const DRIVERS_DIR = new URL('./drivers/', import.meta.url);

/** 同步扫描驱动目录（import() 仍是异步的，见 loadDriverRegistry）。 */
function scanDriverDirs(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
    const entryPath = join(dir.pathname, entry.name, 'index.js');
    if (!existsSync(entryPath)) continue; // 非驱动目录（模板、夹具等）
    out.push({ name: entry.name, entryPath });
  }
  return out;
}

/**
 * 加载驱动注册表：扫描 + import + 形状校验。目录名即驱动 id（渠道记录里的 driver 字段）。
 * 单个驱动 import 失败不拖垮进程（跳过并记日志，对应渠道会被标记不可用）。
 */
export async function loadDriverRegistry({ dir = DRIVERS_DIR, logger } = {}) {
  const drivers = new Map();
  let dirUrl = dir;
  if (typeof dir === 'string') dirUrl = new URL(`file://${dir.endsWith('/') ? dir : `${dir}/`}`);
  for (const { name, entryPath } of scanDriverDirs(dirUrl)) {
    try {
      const mod = await import(pathToFileURL(entryPath).href);
      const driver = mod.default;
      assertDriverExport(driver, name);
      drivers.set(driver.id, driver);
    } catch (error) {
      logger?.error?.('driver_load_failed', { driver: name, message: error?.message });
    }
  }
  return createDriverRegistry(drivers);
}

export function createDriverRegistry(drivers = new Map()) {
  return Object.freeze({
    has: (id) => drivers.has(id),
    get(id) {
      const driver = drivers.get(id);
      if (!driver) throw new ProviderError(`驱动不存在：${id}`, { code: 'DRIVER_NOT_FOUND', submitted: false });
      return driver;
    },
    /** 后台「新增渠道」表单与 GET /admin/drivers 的数据源。 */
    list() {
      return [...drivers.values()].map(({ id, kinds, configSchema }) => ({ id, kinds, configSchema }));
    },
    /**
     * 按渠道记录创建驱动实例。
     * @param {{ id: string, kind: string, name: string, driver: string, baseUrl: string,
     *           credential: string, modelMap?: object, params?: object }} channel 凭证已解密
     * @param {{ logger?: object, deps?: object }} ctx deps 见各驱动 README（loadReference / downloadImage / fetchImpl / sleep）
     */
    create(channel, ctx = {}) {
      const module = this.get(channel.driver);
      if (!module.kinds.includes(channel.kind)) {
        throw new ProviderError(`驱动 ${channel.driver} 不支持 ${channel.kind} 类渠道。`, {
          code: 'PROVIDER_CONFIG_INVALID', submitted: false,
        });
      }
      const instance = module.create(channel, ctx);
      return assertDriverInstance(instance, channel);
    },
  });
}

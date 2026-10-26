// 渠道命令行（ARCHITECTURE §5.5「运营视角」，非程序员可用的应急切换，不依赖后台页面）：
//   npm run channel:list                      列出全部渠道：状态/健康度/在途/成本是否高于用户价
//   npm run channel:use -- <video|image|llm> <渠道名>   把该能力的生效渠道切到指定渠道（只影响新提交）
//   npm run channel:test -- <渠道名>           连接测试（免费，走驱动 catalog()）
//   npm run channel:seed                       首次部署：环境变量种子渠道写库（仅表空时）
// 写操作走 service 层（同后台一致）并写审计（actor=cli）。
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/pool.js';
import { createLogger } from '../src/logger.js';
import { migrate } from '../src/db/migrate.js';
import { loadDriverRegistry } from '../src/engine/providers/index.js';
import { createChannelService } from '../src/channels/service.js';
import { decryptCredential, credentialMask } from '../src/channels/crypto.js';
import { seedChannels } from '../src/worker.js';

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const [command, ...rest] = args;

const USAGE = `用法：
  npm run channel:list
  npm run channel:use -- <video|image|llm> <渠道名>
  npm run channel:test -- <渠道名>
  npm run channel:seed [-- --mock]   # --mock：写入并激活 local-mock 联调渠道（M2-WEB-01）`;

async function main() {
  if (!command || !['list', 'use', 'test', 'seed'].includes(command)) {
    console.error(USAGE);
    process.exit(1);
  }
  const config = loadConfig();
  const logger = createLogger({ level: 'error' });
  const db = createDb({ url: config.databaseUrl, max: 2, logger });
  try {
    await migrate(db, { logger });
    if (!config.channels.secretKey) {
      throw new Error('缺少 CHANNEL_SECRET_KEY（渠道凭证主密钥）');
    }
    const registry = await loadDriverRegistry({ logger });
    const service = createChannelService({ db, secretKey: config.channels.secretKey, registry, logger });

    if (command === 'seed') {
      if (rest.includes('--mock')) {
        // M2-WEB-01 零费用联调：写入并激活 local-mock 渠道（生产拒绝）；切回真实用 channel:use
        const { seedMockChannels } = await import('../src/worker.js');
        const result = await seedMockChannels({ config, db, service, logger });
        console.log(`已写入并激活 local-mock 渠道 ${result.channels.length} 个（video/image/llm）；`
          + '真实渠道转为待命，切回：npm run channel:use -- <kind> <渠道名>');
        return;
      }
      const result = await seedChannels({ config, db, service, logger });
      console.log(result.seeded ? `已写入种子渠道 ${result.channels.length} 个（此后以数据库为准）`
        : '渠道表非空：跳过种子（以数据库为准）');
      return;
    }

    if (command === 'list') {
      const rows = await service.listChannels({ includeRetired: true });
      if (!rows.length) {
        console.log('（还没有渠道；首次部署先 npm run channel:seed，或在后台登记）');
        return;
      }
      const health = await service.healthFor(rows.map((row) => row.id));
      const routes = {};
      for (const kind of ['video', 'image', 'llm']) {
        routes[kind] = (await service.getRoutes(kind)).filter((r) => r.capability === '*');
      }
      console.log('渠道一览（* = 当前生效路由）\n');
      for (const row of rows) {
        const isRoute = routes[row.kind]?.[0]?.id === row.id;
        const h = health.get(row.id);
        const mask = (() => { try { return row.credential_enc ? credentialMask(decryptCredential(config.channels.secretKey, row.credential_enc)) : '（已清除）'; } catch { return '(密文不可解)'; } })();
        const driverOk = registry.has(row.driver);
        const costNote = await service.costVsPrice(row);
        console.log(`${isRoute ? '*' : ' '} [${row.kind}] ${row.name}  ${row.status}${row.status === 'retired' ? '（软删除）' : ''}`);
        console.log(`    渠道ID ${row.id}  驱动 ${row.driver}${driverOk ? '' : '（⚠ 驱动不存在，渠道被跳过）'}  凭证 ${mask}`);
        console.log(`    模型 ${JSON.stringify(row.model_map ?? {})}  成本 ${JSON.stringify(row.cost_fen ?? {})}`);
        const recent = h ? `近1小时：成功 ${h.total - h.failed}/${h.total}，失败 ${h.failed}` : '近1小时：无请求';
        console.log(`    ${recent}${h?.inFlight ? `，在途 ${h.inFlight}` : ''}${costNote ? '  ⚠ 成本高于用户价：' + JSON.stringify(costNote.over) : ''}`);
        console.log('');
      }
      return;
    }

    if (command === 'use') {
      const [kind, name] = rest;
      if (!['video', 'image', 'llm'].includes(kind) || !name) {
        console.error('用法：npm run channel:use -- <video|image|llm> <渠道名>');
        process.exit(1);
      }
      const channel = await service.getChannelByName(kind, name);
      if (!channel) throw new Error(`找不到 ${kind} 类渠道「${name}」`);
      if (channel.status !== 'active') throw new Error(`渠道「${name}」当前是 ${channel.status}，先启用（后台 enable）再切换`);
      if (!registry.has(channel.driver)) throw new Error(`渠道「${name}」的驱动 ${channel.driver} 不存在，无法使用`);
      await service.setRoutes(kind, '*', [channel.id], async (entry) => {
        await db.query(
          `INSERT INTO admin_audit_logs (actor, action, target_type, target_id, detail)
           VALUES ('cli', $1, $2, $3, $4)`,
          [entry.action, entry.targetType, entry.targetId, JSON.stringify({ ...entry.detail, kind })]);
      });
      console.log(`已切换：${kind} 生效渠道 → ${name}（只影响新提交；在途任务仍回原渠道）`);
      return;
    }

    if (command === 'test') {
      const [name] = rest;
      if (!name) { console.error('用法：npm run channel:test -- <渠道名>'); process.exit(1); }
      const rows = await service.listChannels({ includeRetired: true });
      const row = rows.find((r) => r.name === name);
      if (!row) throw new Error(`找不到渠道「${name}」`);
      const started = Date.now();
      try {
        const instance = service.instanceForRow(row, {});
        const catalog = await instance.catalog();
        const modelMap = row.model_map ?? {};
        const mismatches = Object.entries(modelMap)
          .filter(([, model]) => model && !catalog.models.some((m) => m.name === model))
          .map(([capability, model]) => `${capability}:${model}`);
        console.log(`✅ ${name} 连接成功（${Date.now() - started}ms，目录 ${catalog.models.length} 个模型）`);
        console.log(mismatches.length ? `⚠ 渠道配置的模型不在目录：${mismatches.join('、')}` : '✅ 配置的模型都在目录中');
      } catch (error) {
        console.error(`❌ ${name} 连接失败：${error?.message ?? error}`);
        process.exit(1);
      }
      return;
    }
  } finally {
    await db.close();
  }
}

main().catch((err) => { console.error(`执行失败：${err.message}`); process.exit(1); });

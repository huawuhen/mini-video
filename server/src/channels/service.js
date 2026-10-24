// 渠道层服务（ARCHITECTURE §5.5）：渠道 CRUD（凭证加密、软删除）、路由（每能力一个生效渠道）、
// 真实请求健康度统计（channel_events，不发探测请求）、种子引导、驱动实例解析。
// 业务代码（worker / API）只经本层与 router.js 使用渠道，不直接认识驱动。
import { newId } from '../db/ids.js';
import { appError } from '../http/errors.js';
import { encryptCredential, decryptCredential, credentialMask } from './crypto.js';
import { ProviderError } from '../engine/providers/contract.js';

const KINDS = new Set(['video', 'image', 'llm']);

/** 渠道行 → 对外形状（API.md §8 Channel 字段；凭证只回掩码）。 */
export function serializeChannel(row, { health, inFlight, driverAvailable, costVsPrice } = {}) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    driver: row.driver,
    baseUrl: row.base_url,
    credentialMask: credentialMask('decrypted-not-read'), // 掩码由调用方附带（见 withMasks），默认全遮
    modelMap: row.model_map ?? {},
    params: row.params ?? {},
    costFen: row.cost_fen ?? {},
    status: row.status,
    remark: row.remark,
    unavailable: driverAvailable === false ? true : undefined,
    inFlight: inFlight ?? 0,
    recent: health ?? null,
    costVsPrice: costVsPrice ?? null,
    createdAt: row.created_at?.toISOString?.() ?? row.created_at,
    updatedAt: row.updated_at?.toISOString?.() ?? row.updated_at,
  };
}

export function createChannelService({ db, secretKey, registry, logger }) {
  if (!secretKey) throw new Error('渠道层缺少 CHANNEL_SECRET_KEY');

  // ───────── 驱动实例缓存（按 channel_id + updated_at 失效） ─────────
  const instanceCache = new Map(); // channelId → { updatedAt, instance }

  /** 渠道行 → 驱动实例（凭证解密 + registry.create），带进程内缓存。 */
  function instanceFor(row, deps = {}) {
    const cached = instanceCache.get(row.id);
    if (cached && cached.updatedAt === row.updated_at.getTime()) return cached.instance;
    const credential = decryptCredential(secretKey, row.credential_enc);
    const instance = registry.create({
      id: row.id, kind: row.kind, name: row.name, driver: row.driver,
      baseUrl: row.base_url, credential, modelMap: row.model_map, params: row.params,
    }, { logger, deps });
    if (instanceCache.size > 100) instanceCache.clear();
    instanceCache.set(row.id, { updatedAt: row.updated_at.getTime(), instance });
    return instance;
  }

  // ───────── 查询 ─────────

  async function listChannels({ kind, includeRetired = false } = {}) {
    const conditions = [];
    const args = [];
    if (kind) {
      if (!KINDS.has(kind)) throw appError('VALIDATION_FAILED', 'kind 只能是 video/image/llm');
      args.push(kind);
      conditions.push(`kind = $${args.length}`);
    }
    if (!includeRetired) conditions.push(`status <> 'retired'`);
    const { rows } = await db.query(
      `SELECT * FROM provider_channels ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
       ORDER BY kind, name`,
      args,
    );
    return rows;
  }

  async function getChannel(id) {
    const { rows } = await db.query(`SELECT * FROM provider_channels WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  async function getChannelByName(kind, name) {
    const { rows } = await db.query(
      `SELECT * FROM provider_channels WHERE kind = $1 AND name = $2`, [kind, name]);
    return rows[0] ?? null;
  }

  /** 各渠道健康度（近 N 条真实请求，默认窗口 1 小时）+ 在途数 + 成本标记。 */
  async function healthFor(channelIds, { windowSeconds = 3600 } = {}) {
    if (!channelIds.length) return new Map();
    const { rows } = await db.query(
      `SELECT channel_id,
              count(*) FILTER (WHERE outcome <> 'query_failed') AS total,
              count(*) FILTER (WHERE outcome IN ('failed', 'unknown')) AS failed,
              COALESCE(avg(latency_ms) FILTER (WHERE outcome = 'submitted'), 0)::int AS avg_latency_ms
         FROM channel_events
        WHERE channel_id = ANY($1) AND created_at > now() - make_interval(secs => $2)
        GROUP BY channel_id`,
      [channelIds, windowSeconds],
    );
    const inflight = await db.query(
      `SELECT channel_id, count(*) AS n FROM gen_tasks
        WHERE channel_id = ANY($1) AND status IN ('submitting', 'running')
        GROUP BY channel_id`,
      [channelIds],
    );
    const health = new Map();
    for (const row of rows) {
      const total = Number(row.total);
      const failed = Number(row.failed);
      health.set(row.channel_id, {
        total, failed,
        successRate: total ? Math.round(((total - failed) / total) * 100) / 100 : null,
        avgQueueSeconds: row.avg_latency_ms ? Math.round(row.avg_latency_ms / 100) / 10 : null,
      });
    }
    for (const row of inflight.rows) {
      const entry = health.get(row.channel_id) ?? { total: 0, failed: 0, successRate: null, avgQueueSeconds: null };
      entry.inFlight = Number(row.n);
      health.set(row.channel_id, entry);
    }
    return health;
  }

  /**
   * 成本标记：渠道 cost_fen（按能力键如 video.480p / image.look）高于「逻辑 SKU 用户价」的项。
   * 数据来源都是库内数据，纯比较；用户价取当前生效逻辑 SKU。
   */
  async function costVsPrice(channel) {
    const { rows: skus } = await db.query(
      `SELECT sku_code, price_fen FROM skus WHERE channel = 'logical' AND status = 'active'`);
    const priceByCode = new Map(skus.map((s) => [s.sku_code, s.price_fen]));
    const over = [];
    for (const [capability, cost] of Object.entries(channel.cost_fen ?? {})) {
      const price = priceByCode.get(capability);
      if (price !== undefined && Number(cost) > price) over.push({ capability, costFen: Number(cost), priceFen: price });
    }
    return over.length ? { over } : null;
  }

  // ───────── 写操作（全部写审计） ─────────

  async function createChannel({ kind, name, driver: driverId, baseUrl, credential, modelMap, params, costFen, remark }, audit) {
    if (!KINDS.has(kind)) throw appError('VALIDATION_FAILED', 'kind 只能是 video/image/llm');
    if (!name || typeof name !== 'string' || !/^[^\s]{1,40}$/.test(name)) throw appError('VALIDATION_FAILED', '渠道名不合法（1~40 字符，不含空格）');
    if (!registry.has(driverId)) throw appError('DRIVER_NOT_FOUND');
    if (!baseUrl || typeof baseUrl !== 'string') throw appError('VALIDATION_FAILED', '渠道地址不合法');
    if (!credential || typeof credential !== 'string') throw appError('VALIDATION_FAILED', '渠道凭证不合法');
    const id = newId('pch');
    const credentialEnc = encryptCredential(secretKey, credential);
    const { rows } = await db.query(
      `INSERT INTO provider_channels (id, kind, name, driver, base_url, credential_enc, model_map, params, cost_fen, remark)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [id, kind, name, driverId, baseUrl.replace(/\/+$/, ''), credentialEnc,
        JSON.stringify(modelMap ?? {}), JSON.stringify(params ?? {}),
        JSON.stringify(costFen ?? {}), String(remark ?? '')],
    );
    await audit({ action: 'channel.create', targetType: 'provider_channel', targetId: id,
      detail: { kind, name, driver: driverId, baseUrl, modelMap: modelMap ?? {}, costFen: costFen ?? {} } });
    return rows[0];
  }

  async function updateChannel(id, patch, audit) {
    const { name, baseUrl, credential, modelMap, params, costFen, remark } = patch ?? {};
    const existing = await getChannel(id);
    if (!existing || existing.status === 'retired') throw appError('CHANNEL_NOT_FOUND', '渠道不存在或已删除');
    const sets = [];
    const args = [];
    const push = (column, value) => {
      args.push(value);
      sets.push(`${column} = $${args.length}`);
    };
    if (name !== undefined) {
      if (!name || typeof name !== 'string' || !/^[^\s]{1,40}$/.test(name)) throw appError('VALIDATION_FAILED', '渠道名不合法');
      push('name', name);
    }
    if (baseUrl !== undefined) push('base_url', String(baseUrl).replace(/\/+$/, ''));
    if (credential !== undefined) {
      if (!credential || typeof credential !== 'string') throw appError('VALIDATION_FAILED', '渠道凭证不合法');
      push('credential_enc', encryptCredential(secretKey, credential));
    }
    if (modelMap !== undefined) push('model_map', JSON.stringify(modelMap));
    if (params !== undefined) push('params', JSON.stringify(params));
    if (costFen !== undefined) push('cost_fen', JSON.stringify(costFen));
    if (remark !== undefined) push('remark', String(remark));
    if (!sets.length) return existing;
    sets.push('updated_at = now()');
    const { rows } = await db.query(
      `UPDATE provider_channels SET ${sets.join(', ')} WHERE id = $${args.length + 1} RETURNING *`,
      [...args, id],
    );
    await audit({ action: 'channel.update', targetType: 'provider_channel', targetId: id,
      detail: { fields: Object.keys(patch ?? {}).filter((key) => key !== 'credential') } });
    return rows[0];
  }

  async function setChannelStatus(id, status, audit) {
    const existing = await getChannel(id);
    if (!existing) throw appError('CHANNEL_NOT_FOUND', '渠道不存在');
    if (existing.status === 'retired') throw appError('CHANNEL_NOT_FOUND', '渠道已删除，不能变更状态');
    const { rows } = await db.query(
      `UPDATE provider_channels SET status = $2, updated_at = now() WHERE id = $1 RETURNING *`, [id, status]);
    await audit({ action: `channel.${status === 'active' ? 'enable' : 'disable'}`,
      targetType: 'provider_channel', targetId: id, detail: { from: existing.status } });
    return rows[0];
  }

  /**
   * 软删除（retired）：不再被路由选中；在途任务清空前凭证保留（仍可轮询），清空后可清除凭证。
   * 「在途清空」检查由定时清理完成（cron channels.retired_sweep），此处不阻塞删除。
   */
  async function retireChannel(id, audit) {
    const existing = await getChannel(id);
    if (!existing) throw appError('CHANNEL_NOT_FOUND', '渠道不存在');
    const { rowCount } = await db.query(
      `UPDATE provider_channels SET status = 'retired', updated_at = now()
        WHERE id = $1 AND status <> 'retired'`, [id]);
    await db.query(`DELETE FROM channel_routes WHERE channel_id = $1`, [id]);
    await audit({ action: 'channel.retire', targetType: 'provider_channel', targetId: id, detail: {} });
    return (rowCount > 0) ? { ...existing, status: 'retired' } : existing;
  }

  /** 在途清空的软删除渠道：清除凭证（渠道名等保留供对账）。定时任务调用。 */
  async function sweepRetiredCredentials() {
    const result = await db.query(
      `UPDATE provider_channels p SET credential_enc = '', updated_at = now()
        WHERE p.status = 'retired' AND p.credential_enc <> ''
          AND NOT EXISTS (
            SELECT 1 FROM gen_tasks g WHERE g.channel_id = p.id AND g.status IN ('submitting', 'running'))`,
    );
    return { cleared: result.rowCount ?? 0 };
  }

  // ───────── 路由 ─────────

  async function getRoutes(kind) {
    const { rows } = await db.query(
      `SELECT r.capability, r.rank, c.id, c.name, c.status, c.driver
         FROM channel_routes r JOIN provider_channels c ON c.id = r.channel_id
        WHERE r.kind = $1 ORDER BY r.capability, r.rank`, [kind]);
    return rows;
  }

  /** 设置路由（整体替换该 kind + capability 的列表）。 */
  async function setRoutes(kind, capability, channelIds, audit) {
    if (!KINDS.has(kind)) throw appError('VALIDATION_FAILED', 'kind 只能是 video/image/llm');
    if (capability !== '*' && !/^[a-z0-9.*-]+$/i.test(capability)) throw appError('VALIDATION_FAILED', 'capability 不合法');
    const seen = new Set();
    for (const id of channelIds) {
      if (seen.has(id)) throw appError('VALIDATION_FAILED', '渠道列表有重复');
      seen.add(id);
      const channel = await getChannel(id);
      if (!channel) throw appError('CHANNEL_NOT_FOUND', `渠道不存在：${id}`);
      if (channel.kind !== kind) throw appError('VALIDATION_FAILED', `渠道 ${id} 不是 ${kind} 类`);
    }
    await db.tx(async (t) => {
      await t.query(`DELETE FROM channel_routes WHERE kind = $1 AND capability = $2`, [kind, capability]);
      let rank = 0;
      for (const id of channelIds) {
        rank += 1;
        await t.query(`INSERT INTO channel_routes (kind, capability, channel_id, rank) VALUES ($1,$2,$3,$4)`,
          [kind, capability, id, rank]);
      }
    });
    await audit({ action: 'route.set', targetType: 'channel_route', targetId: `${kind}/${capability}`,
      detail: { channelIds } });
  }

  /**
   * 生效渠道解析（router.pick 的数据源）：rank 最小的 active 且驱动存在且路由指向的渠道。
   * 备用渠道不参与（用户 2026-10-24：备用不自动启用）。返回 null = 该能力当前无生效渠道。
   */
  async function pickRow(kind, { capability = '*' } = {}) {
    let targetCapability = capability;
    let rows = [];
    for (const cap of [capability, '*']) {
      targetCapability = cap;
      const result = await db.query(
        `SELECT c.* FROM channel_routes r JOIN provider_channels c ON c.id = r.channel_id
          WHERE r.kind = $1 AND r.capability = $2 AND c.status = 'active'
          ORDER BY r.rank LIMIT 1`,
        [kind, cap]);
      rows = result.rows;
      if (rows.length) break;
    }
    void targetCapability;
    if (!rows.length) return null;
    const row = rows[0];
    if (!registry.has(row.driver)) {
      // 驱动缺失：该渠道跳过并告警（在途任务保持原状，不退款不重提）
      logger?.error?.('channel_driver_missing', { channelId: row.id, driver: row.driver });
      return null;
    }
    return row;
  }

  // ───────── 真实请求统计 ─────────

  async function recordEvent({ channelId, genTaskId = null, outcome, latencyMs = null, errorCode = null }) {
    await db.query(
      `INSERT INTO channel_events (channel_id, gen_task_id, outcome, latency_ms, error_code)
       VALUES ($1,$2,$3,$4,$5)`,
      [channelId, genTaskId, outcome, Number.isFinite(latencyMs) ? Math.round(latencyMs) : null,
        errorCode ? String(errorCode).slice(0, 40) : null],
    ).catch((err) => logger?.warn?.('channel_event_write_failed', { channelId, message: err?.message }));
  }

  // ───────── 种子引导（首次部署：环境变量 → 种子渠道；仅表为空时） ─────────

  /**
   * @param seeds [{ kind, name, driver, baseUrl, credential, modelMap, params, costFen, remark, activate }]
   *        activate=true 的作为该 kind 的生效路由（其余不建路由）。仅 provider_channels 空表时写入。
   * @returns { seeded: boolean, channels: [...] }
   */
  async function seedFromEnv(seeds, audit) {
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM provider_channels`);
    if (rows[0].n > 0) return { seeded: false, channels: [] };
    const created = [];
    for (const seed of seeds) {
      if (!seed?.credential || !seed.baseUrl || !registry.has(seed.driver ?? '')) continue; // 缺关键配置：跳过该种子
      const row = await createChannel(seed, audit);
      created.push(row);
      if (seed.activate) {
        await db.query(`INSERT INTO channel_routes (kind, capability, channel_id, rank) VALUES ($1,'*',$2,1)
           ON CONFLICT (kind, capability, channel_id) DO NOTHING`, [row.kind, row.id]);
      }
    }
    return { seeded: created.length > 0, channels: created };
  }

  /** 驱动实例（带 in-flight 判定）：停用/软删除渠道仍可创建实例（在途任务轮询用）。 */
  function instanceForRow(row, deps) {
    if (!registry.has(row.driver)) {
      throw new ProviderError(`驱动不存在：${row.driver}`, { code: 'DRIVER_NOT_FOUND', submitted: false });
    }
    return instanceFor(row, deps);
  }

  return {
    listChannels, getChannel, getChannelByName, healthFor, costVsPrice,
    createChannel, updateChannel, setChannelStatus, retireChannel, sweepRetiredCredentials,
    getRoutes, setRoutes, pickRow, recordEvent, seedFromEnv, instanceForRow,
    hasDriver: (id) => registry.has(id),
  };
}

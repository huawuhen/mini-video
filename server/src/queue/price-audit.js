// 渠道模型存在性对账（M2-BE-01，替代原「目录价 vs cost_fen」比对——喵呜渠道的 /v1/models
// 不含价格字段，价格快照人工维护在 migrations/005 注释与模型广场页面，2026-10-22 核对）。
// 定时（providers.price_audit，默认每 6 小时；调度器启动即入队一次）拉实时模型目录，
// 校验本渠道 SKU 的 model 是否仍在售；缺失/下架记 error 日志（provider_model_missing）供运维处置。
// 只在 GEN_UPSTREAMS=real 下执行；目录接口免费。纯函数可注入假目录测试。
export function createPriceAuditHandler({ db, logger, config, fetchCatalog }) {
  if (typeof fetchCatalog !== 'function') throw new TypeError('需要注入 fetchCatalog');
  return async function providersPriceAudit() {
    if (!config.providers.real) {
      logger.info('price_audit_skip_mock', { reason: 'GEN_UPSTREAMS != real' });
      return;
    }
    const raw = await fetchCatalog();
    const items = raw.data ?? raw.models ?? [];
    const available = new Set(items.map((item) => item.id));
    const { rows: skus } = await db.query(
      `SELECT sku_code, kind, model, resolution FROM skus
        WHERE status = 'active' AND channel = 'miaowuai'`,
    );
    const missing = skus.filter((sku) => !available.has(sku.model));
    if (missing.length) {
      logger.error('provider_model_missing', {
        count: missing.length,
        missing: missing.map((sku) => ({ skuCode: sku.sku_code, model: sku.model })),
        hint: '渠道模型目录中不存在该 SKU 的模型：核实是否下架/改名，必要时用新迁移切换 SKU 并调整售价（须用户决策）',
      });
    } else {
      logger.info('price_audit_ok', { checked: skus.length });
    }
  };
}

/** 单个 SKU 的目录存在性校验（保留纯函数供测试与后续价格比对扩展）。 */
export function expectedModelPresence(sku, catalogById) {
  if (!catalogById.has(sku.model)) return { ok: false, reason: 'MODEL_MISSING' };
  return { ok: true };
}

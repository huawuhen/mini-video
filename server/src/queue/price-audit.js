// 渠道调价对账（M2-BE-01，用户 2026-10-22 决策：渠道成本以实时目录为准，调价须报警）。
// 定时（providers.price_audit，默认每 6 小时；调度器启动即入队一次）拉实时目录，
// 与 skus.cost_fen 比对，漂移记 error 日志（provider_price_drift）供运维处置。
// 只在 GEN_UPSTREAMS=real 下执行；目录接口免费。解析与比对是纯函数，可注入假目录测试。
export function createPriceAuditHandler({ db, logger, config, fetchCatalog }) {
  if (typeof fetchCatalog !== 'function') throw new TypeError('需要注入 fetchCatalog');
  return async function providersPriceAudit() {
    if (!config.providers.real) {
      logger.info('price_audit_skip_mock', { reason: 'GEN_UPSTREAMS != real' });
      return;
    }
    const raw = await fetchCatalog();
    const items = raw.data ?? raw.models ?? [];
    const byId = new Map(items.map((item) => [item.id, item]));
    const { rows: skus } = await db.query(
      `SELECT sku_code, kind, model, resolution, cost_fen FROM skus
        WHERE status = 'active' AND channel = 'modelhub'`,
    );
    const drifts = [];
    for (const sku of skus) {
      const result = expectedCostFen(sku, byId, { imageDetailLevel: config.providers.imageDetailLevel });
      if (!result.ok) {
        drifts.push({ skuCode: sku.sku_code, model: sku.model, resolution: sku.resolution,
          costFen: sku.cost_fen, ...result });
      }
    }
    if (drifts.length) {
      logger.error('provider_price_drift', {
        count: drifts.length, drifts,
        hint: '渠道目录价格与 skus.cost_fen 不一致：核实后用新迁移更新成本，售价调整须用户决策',
      });
    } else {
      logger.info('price_audit_ok', { checked: skus.length });
    }
  };
}

/** 单个 SKU 的目录价核对。视频按「分辨率区间 [min,max]」，图片按「分辨率 × 细节档」精确值。 */
export function expectedCostFen(sku, catalogById, { imageDetailLevel }) {
  const entry = catalogById.get(sku.model); // skus.model 即目录模型 id（seedance-2.5 / gpt-image-2.5-flare）
  if (!entry) return { ok: false, reason: 'MODEL_MISSING' };
  const pricing = entry.pricing ?? {};
  if (sku.kind === 'video') {
    const range = pricing.resolutions?.[sku.resolution];
    if (!range) return { ok: false, reason: 'RESOLUTION_MISSING' };
    if (sku.cost_fen < range.min || sku.cost_fen > range.max) {
      return { ok: false, reason: 'COST_DRIFT', expectedMinFen: range.min, expectedMaxFen: range.max };
    }
    return { ok: true };
  }
  if (sku.kind === 'image') {
    const price = pricing.prices?.[sku.resolution]?.[imageDetailLevel];
    if (!Number.isInteger(price)) return { ok: false, reason: 'PRICE_TIER_MISSING' };
    if (sku.cost_fen !== price) return { ok: false, reason: 'COST_DRIFT', expectedFen: price };
    return { ok: true };
  }
  return { ok: true };
}

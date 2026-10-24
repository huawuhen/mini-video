// 渠道模型存在性对账（M2-BE-01 → M2-BE-03 改走渠道层）：定时（providers.price_audit，默认每 6 小时；
// 调度器启动即入队一次）对每个「生效渠道」调驱动的免费目录接口 catalog()，校验渠道 model_map 的
// 模型是否仍在售；缺失记 error 日志（provider_model_missing）供运维处置。只在 GEN_UPSTREAMS=real 下执行；
// 目录接口免费。驱动实例经渠道路由层创建（无生效渠道的 kind 跳过）。
export function createPriceAuditHandler({ db, logger, config, channelLayer }) {
  return async function providersPriceAudit() {
    if (!config.providers.real || !channelLayer) {
      logger.info('price_audit_skip_mock', { reason: 'GEN_UPSTREAMS != real' });
      return;
    }
    const { router } = channelLayer;
    let checked = 0;
    for (const kind of ['video', 'image', 'llm']) {
      let picked;
      try {
        picked = await router.pick(kind);
      } catch {
        continue; // 该能力当前无生效渠道（NO_ACTIVE_CHANNEL）：用户侧已有明确报错，跳过
      }
      const modelMap = picked.channel.model_map ?? {};
      const models = new Set(Object.values(modelMap).filter(Boolean));
      if (!models.size) {
        logger.warn('price_audit_no_model_map', { channelId: picked.channelId, kind });
        continue;
      }
      try {
        const catalog = await picked.instance.catalog();
        const available = new Set(catalog.models.map((item) => item.name));
        const missing = [...models].filter((model) => !available.has(model));
        checked += models.size;
        if (missing.length) {
          logger.error('provider_model_missing', {
            channelId: picked.channelId, kind, missing,
            hint: '生效渠道的模型不在其目录中：核实是否下架/改名，必要时用后台或 CLI 切换渠道',
          });
        } else {
          logger.info('price_audit_ok', { channelId: picked.channelId, kind, checked: models.size });
        }
      } catch (error) {
        logger.warn('price_audit_catalog_failed', { channelId: picked.channelId, kind, message: error?.message });
      }
    }
    logger.info('price_audit_done', { checked });
  };
}

/** 模型集合的目录存在性校验（保留纯函数供测试）。 */
export function expectedModelPresence(models, catalogById) {
  const missing = [...models].filter((model) => !catalogById.has(model));
  return { ok: missing.length === 0, missing };
}

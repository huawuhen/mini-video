// 目录与运营配置（docs/API.md §2）。只读查询，供首页、确认页、engine 与 wallet 使用。
// 写法范例：service 只接收 db 与依赖，返回符合 API 契约的纯对象；路由层不写 SQL。

export const VOICE_CATEGORY_NAMES = {
  girl: '少女', boy: '少年', child_f: '儿童女', child_m: '儿童男', young_f: '青年女',
  young_m: '青年男', middle_f: '中年女', middle_m: '中年男', elder_f: '老人女', elder_m: '老人男',
};

/** 读取全部运营配置为对象：{ max_duration_seconds: 90, ... } */
export async function getSettings(db) {
  const { rows } = await db.query('SELECT key, value FROM settings');
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

/** 档位当前生效的映射与视频 SKU（最新 version 且已生效、SKU 为 active 的最新版本）。 */
export async function getActiveTierSkus(db) {
  const { rows } = await db.query(`
    SELECT DISTINCT ON (m.tier_id)
           m.tier_id, m.id AS mapping_id, s.sku_code, s.version AS sku_version, s.price_fen, s.durations
      FROM tier_mappings m
      JOIN LATERAL (
        SELECT * FROM skus k
         WHERE k.sku_code = m.video_sku_code AND k.status = 'active' AND k.effective_at <= now()
         ORDER BY k.version DESC LIMIT 1
      ) s ON true
     WHERE m.effective_at <= now()
     ORDER BY m.tier_id, m.version DESC`);
  return new Map(rows.map((r) => [r.tier_id, r]));
}

/**
 * @param {{ urlFor?: (key: string) => string | undefined }} deps  媒体签名链接（engine/storage 提供）
 */
export async function getCatalog(db, { urlFor = () => undefined } = {}) {
  const [styles, tiers, tierSkus, settings] = await Promise.all([
    db.query(`SELECT id, name, description, cover_key FROM styles WHERE status = 'active' ORDER BY sort, id`),
    db.query(`SELECT id, name, note FROM quality_tiers WHERE status = 'active' ORDER BY sort, id`),
    getActiveTierSkus(db),
    getSettings(db),
  ]);
  return {
    styles: styles.rows.map((s) => withOptional({ id: s.id, name: s.name, description: s.description }, 'coverUrl', s.cover_key && urlFor(s.cover_key))),
    // 没有生效映射的档位不展示，避免用户选到无法报价的档位
    qualityTiers: tiers.rows.filter((t) => tierSkus.has(t.id)).map((t) => ({
      id: t.id, name: t.name, note: t.note, pricePer30sFen: tierSkus.get(t.id).price_fen * 30,
    })),
    ratios: ['9:16', '16:9', '1:1'],
    limits: {
      minStoryChars: settings.min_story_chars,
      maxStoryChars: settings.max_story_chars,
      maxDurationSeconds: settings.max_duration_seconds,
      dailyFreeUnderstanding: settings.daily_free_understanding,
      retentionDays: settings.retention_days,
      expiryRemindDays: settings.expiry_remind_days,
      maxCharacterPhotos: settings.max_character_photos,
    },
  };
}

export async function listVoices(db, { category, urlFor = () => undefined } = {}) {
  const { rows } = await db.query(
    `SELECT id, name, category, description, sample_key FROM voices
      WHERE status = 'active' AND ($1::text IS NULL OR category = $1)
      ORDER BY sort, id`,
    [category ?? null],
  );
  return rows.map((v) => withOptional(
    { id: v.id, name: v.name, category: v.category, categoryName: VOICE_CATEGORY_NAMES[v.category], description: v.description },
    'sampleUrl', v.sample_key && urlFor(v.sample_key),
  ));
}

function withOptional(obj, key, value) {
  if (value) obj[key] = value;
  return obj;
}

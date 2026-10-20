// project.compose（docs/ARCHITECTURE §4）：取各段已选中 take → render.compose（硬切 + 响度统一 +
// 显式/隐式 AI 标识 + 封面）→ 转存成片与封面 → delivered（写 delivered_at / expires_at）。
// fetchLocal 由调用方注入：生产用 signedUrl + safeFetch 拉回本地；测试注入固定样片。
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newId } from '../db/ids.js';
import { PermanentJobError } from '../queue/index.js';
import { transition, updateProgress } from './state.js';

export function createComposeHandler({ db, logger, config, storage, render, fetchLocal }) {
  return async function projectCompose(payload, ctx) {
    const projectId = payload.projectId;
    const { rows: current } = await db.query(
      `SELECT id, user_id, status, ratio, tier_mapping_id FROM projects WHERE id = $1`, [projectId]);
    if (!current.length) throw new PermanentJobError('作品不存在');
    const project = current[0];
    if (!['rendering', 'composing'].includes(project.status)) {
      ctx.logger.info('project_compose_skip', { projectId, status: project.status });
      return;
    }
    const userId = project.user_id;
    const { rows: segmentRows } = await db.query(
      `SELECT s.idx, s.transition, t.video_key
         FROM segments s JOIN segment_takes t ON t.id = s.selected_take_id
        WHERE s.project_id = $1 AND t.status = 'succeeded'
        ORDER BY s.idx`, [projectId]);
    if (!segmentRows.length) throw new PermanentJobError('没有可拼接的片段');
    const { rows: skuRows } = await db.query(
      `SELECT s.resolution FROM tier_mappings tm
         JOIN skus s ON s.sku_code = tm.video_sku_code AND s.kind = 'video' AND s.status = 'active'
        WHERE tm.id = $1 ORDER BY s.version DESC LIMIT 1`, [project.tier_mapping_id]);
    const resolution = skuRows[0]?.resolution ?? '720p';

    if (project.status === 'rendering') {
      await db.tx(async (t) => transition(t, { projectId, userId, from: ['rendering'], to: 'composing',
        progress: { percent: 95, message: '正在拼接成片' }, changed: [] }).catch(() => {}));
    }
    const renderId = newId('rnd');
    await db.tx(async (t) => {
      await t.query(
        `INSERT INTO renders (id, project_id, takes_snapshot, status) VALUES ($1, $2, $3, 'running')`,
        [renderId, projectId, JSON.stringify(segmentRows.map((row) => row.video_key))],
      );
      await updateProgress(t, { projectId, progress: { percent: 95, message: '正在拼接成片' } });
    });

    const workDir = await mkdtemp(join(tmpdir(), 'miv-compose-'));
    try {
      const inputs = [];
      for (const segment of segmentRows) {
        const localPath = join(workDir, `take-${segment.idx}.mp4`);
        await fetchLocal(segment.video_key, localPath);
        inputs.push({ localPath, transition: segment.transition });
      }
      await ctx.extendLease?.();
      const composed = await render.compose({ inputs, ratio: project.ratio, resolution });
      await ctx.extendLease?.();
      const videoKey = `users/${userId}/projects/${projectId}/renders/${renderId}.mp4`;
      const coverKey = `users/${userId}/projects/${projectId}/renders/${renderId}.cover.jpg`;
      await storage.put(videoKey, await readFile(composed.outputPath));
      await storage.put(coverKey, await readFile(composed.coverPath));
      const expiresAt = new Date(Date.now() + config.projects.retentionDays * 86_400_000);
      await db.tx(async (t) => {
        const claimed = await t.query(
          `UPDATE renders SET status = 'succeeded', video_key = $2, cover_key = $3,
             duration_seconds = $4 WHERE id = $1 AND status = 'running' RETURNING id`,
          [renderId, videoKey, coverKey, Math.round(composed.durationSeconds)],
        );
        if (!claimed.rows.length) return;
        await transition(t, { projectId, userId, from: ['composing'], to: 'delivered',
          progress: { percent: 100, message: '已完成' }, changed: ['render'] });
        await t.query(
          `UPDATE projects SET delivered_at = now(), expires_at = $2, updated_at = now() WHERE id = $1`,
          [projectId, expiresAt],
        );
      });
      ctx.logger.info('project_composed', { projectId, renderId, durationSeconds: composed.durationSeconds });
    } catch (error) {
      await db.tx(async (t) => {
        await t.query(`UPDATE renders SET status = 'failed', error = $2 WHERE id = $1 AND status = 'running'`,
          [renderId, JSON.stringify({ message: String(error.message).slice(0, 300) })]);
        await transition(t, { projectId, userId, from: ['composing'], to: 'failed',
          error: { code: 'COMPOSE_FAILED', message: '成片拼接失败，可重试', step: 'composing' },
          progress: { percent: 0, message: '拼接失败' } }).catch(() => {});
      });
      logger.error('project_compose_failed', { projectId, renderId, err: String(error.message) });
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  };
}

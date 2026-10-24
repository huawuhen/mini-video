// 作品路由（docs/API.md §6）。只做参数校验与编排，业务在 projects/service.js 与各 job。
// 全部要求登录；写操作由挂载在其前的 csrfGuard 校验同源 + CSRF；他人资源一律 404。
// SSE（GET /projects/:id/events）：EventSource 只能带 Cookie，走会话鉴权；先发当前快照，
// 再从 Last-Event-ID 增量补发；没带 Last-Event-ID 的新连接从「当前最大事件 id」起只推新事件
// （快照已代表当前，重放历史会让界面回跳）；到期由服务端主动结束，客户端按 EventSource
// 默认行为带 Last-Event-ID 重连；每用户并发连接设上限。
import { Router } from 'express';
import { requireAuth } from '../auth/session.js';
import { asyncHandler } from '../http/middleware.js';
import { Fields } from '../http/validate.js';
import { appError } from '../http/errors.js';
import {
  cancelProject, confirmCast, confirmStory, createProject, createSegmentTake,
  createCastLook, deleteProject, getProjectDetail, listProjects, pauseProject,
  projectDownload, reanalyzeProject, resumeProject, retryProject, selectSegmentTake,
  updateCast, updateCastCharacter, updateSegmentPlot,
} from '../projects/service.js';

const SSE_POLL_MS = 1000;
const SSE_HEARTBEAT_MS = 15_000;

export function projectRoutes({ db, logger, config, storage, urlFor, channelRouter = null }) {
  const router = Router();
  const detail = (req, projectId) => getProjectDetail(db, {
    userId: req.user.id, projectId: projectId ?? req.params.id, urlFor,
  });
  // 每用户在本进程内打开的 SSE 连接（复审建议 6：每连接每秒查一次库，先按用户限流）
  const sseConnections = new Map();

  // ── §6.1 列表与创建 ──
  router.get('/projects', requireAuth, asyncHandler(async (req, res) => {
    const limit = req.query.limit === undefined ? undefined : Number(req.query.limit);
    res.json(await listProjects(db, {
      userId: req.user.id, group: req.query.group, cursor: req.query.cursor,
      limit: Number.isSafeInteger(limit) ? limit : undefined, urlFor,
    }));
  }));

  router.post('/projects', requireAuth, asyncHandler(async (req, res) => {
    const f = new Fields(req.body);
    const storyText = f.string('storyText', { required: true, max: 3000 });
    const sourceType = f.oneOf('sourceType', ['text', 'file'], { required: true });
    const title = f.string('title', { max: 60 });
    const styleId = f.string('styleId', { required: true, max: 64 });
    const qualityTierId = f.string('qualityTierId', { required: true, max: 64 });
    const ratio = f.oneOf('ratio', ['9:16', '16:9', '1:1']);
    const characterIds = f.stringArray('characterIds', { maxItems: 20, maxLength: 64 }) ?? [];
    const idempotencyKey = f.string('idempotencyKey', { required: true, max: 64 });
    f.done();
    const { replayed, projectId } = await createProject(db, { channelRouter,
      userId: req.user.id,
      input: { storyText, sourceType, title, styleId, qualityTierId, ratio, characterIds, idempotencyKey },
      config,
    });
    res.status(replayed ? 200 : 201).json(await detail(req, projectId));
  }));

  router.get('/projects/:id', requireAuth, asyncHandler(async (req, res) => {
    res.json(await detail(req));
  }));

  // SSE：鉴权（会话 Cookie）→ 校验归属与连接上限 → 先发当前快照，再增量补发新事件
  router.get('/projects/:id/events', requireAuth, asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const projectId = req.params.id;
    const owned = await db.query(
      `SELECT 1 FROM projects WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [projectId, userId],
    );
    if (!owned.rows.length) throw appError('NOT_FOUND');

    const open = sseConnections.get(userId) ?? new Set();
    const maxConnections = config.projects.sseMaxConnectionsPerUser;
    if (open.size >= maxConnections) throw appError('RATE_LIMITED', '打开的实时连接太多，请稍后再试');
    open.add(res);
    sseConnections.set(userId, open);
    const release = () => {
      open.delete(res);
      if (!open.size) sseConnections.delete(userId);
    };

    // 复审必改 3(a)：没带 Last-Event-ID 的新连接从当前最大事件 id 起（快照代表「当前」，
    // 查询带 id > 条件，不重放历史事件）；带了则从客户端最后收到的事件之后补发
    const lastEventId = Number.parseInt(req.get('last-event-id') ?? '', 10);
    let lastId = Number.isSafeInteger(lastEventId) && lastEventId > 0 ? lastEventId : null;
    if (lastId === null) {
      const { rows: maxRows } = await db.query(
        `SELECT COALESCE(MAX(id), 0) AS max_id FROM project_events WHERE project_id = $1`,
        [projectId],
      );
      lastId = Number(maxRows[0].max_id);
    }

    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    }).flushHeaders?.();
    res.write(':ok\n\n');

    const send = (event) => {
      res.write(`id: ${event.id}\nevent: project\ndata: ${JSON.stringify({
        projectId: event.project_id, status: event.status,
        progress: event.progress, changed: event.changed ?? [],
      })}\n\n`);
    };

    let stopped = false;
    const startedAt = Date.now();
    const maxAgeMs = config.projects.sseMaxAgeMs;

    const tick = async () => {
      if (stopped) return;
      const params = [projectId, lastId];
      const { rows } = await db.query(
        `SELECT id, project_id, status, progress, changed FROM project_events
          WHERE project_id = $1 AND id > $2 ORDER BY id ASC LIMIT 100`, params,
      );
      for (const event of rows) {
        if (event.status !== 'unchanged') send(event);
        lastId = Number(event.id);
      }
      // 复审必改 3(b)：到期服务端主动结束（此前只停轮询不关连接，客户端既收不到事件
      // 也不会重连）；EventSource 会按默认行为带 Last-Event-ID 重连
      if (Date.now() - startedAt > maxAgeMs) stop();
    };

    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(pollTimer);
      clearInterval(heartbeat);
      release();
      if (!res.writableEnded) res.end();
    };

    // 当前快照（客户端可用它直接渲染；重连时若没有错过事件也有最新状态）
    const snapshot = await db.query(`SELECT status, progress FROM projects WHERE id = $1`, [projectId]);
    if (snapshot.rows[0]) {
      res.write(`event: project\ndata: ${JSON.stringify({
        projectId, status: snapshot.rows[0].status, progress: snapshot.rows[0].progress, changed: [],
      })}\n\n`);
    }

    const pollTimer = setInterval(() => { tick().catch((error) => {
      logger.warn('sse_tick_failed', { projectId, err: String(error.message) });
    }); }, SSE_POLL_MS);
    const heartbeat = setInterval(() => { if (!stopped) res.write(':hb\n\n'); }, SSE_HEARTBEAT_MS);
    req.on('close', stop);
  }));

  router.delete('/projects/:id', requireAuth, asyncHandler(async (req, res) => {
    res.json(await deleteProject(db, { userId: req.user.id, projectId: req.params.id, storage }));
  }));

  // ── §6.3 确认点 A ──
  router.post('/projects/:id/story/reanalyze', requireAuth, asyncHandler(async (req, res) => {
    const f = new Fields(req.body);
    const storyText = f.string('storyText', { required: true, max: 3000 });
    f.done();
    await reanalyzeProject(db, { userId: req.user.id, projectId: req.params.id, storyText, config });
    res.json(await detail(req));
  }));

  router.put('/projects/:id/cast/:castId/character', requireAuth, asyncHandler(async (req, res) => {
    const f = new Fields(req.body);
    const characterId = f.string('characterId', { max: 64 });
    f.done();
    const explicit = Object.prototype.hasOwnProperty.call(req.body, 'characterId');
    if (!explicit) throw appError('VALIDATION_FAILED', undefined, { fields: { characterId: '必填（可为 null）' } });
    await updateCastCharacter(db, { userId: req.user.id, projectId: req.params.id,
      castId: req.params.castId, characterId: req.body.characterId ?? null });
    res.json(await detail(req));
  }));

  router.post('/projects/:id/confirm-story', requireAuth, asyncHandler(async (req, res) => {
    const f = new Fields(req.body);
    const quoteId = f.string('quoteId', { max: 64 });
    const idempotencyKey = f.string('idempotencyKey', { required: true, max: 64 });
    f.done();
    await confirmStory(db, { channelRouter, userId: req.user.id, projectId: req.params.id,
      quoteId: quoteId ?? undefined, idempotencyKey, config });
    res.json(await detail(req));
  }));

  // ── §6.4 确认点 B ──
  router.put('/projects/:id/cast/:castId', requireAuth, asyncHandler(async (req, res) => {
    const f = new Fields(req.body);
    const lookVersionId = f.string('lookVersionId', { max: 64 });
    const voiceId = f.string('voiceId', { max: 64 });
    f.done();
    // 复审建议 7：显式传 null 表示「清除选择」，不能被 ?? undefined 吞掉
    await updateCast(db, { userId: req.user.id, projectId: req.params.id, castId: req.params.castId,
      ...(Object.prototype.hasOwnProperty.call(req.body, 'lookVersionId') ? { lookVersionId: req.body.lookVersionId ?? null } : {}),
      ...(Object.prototype.hasOwnProperty.call(req.body, 'voiceId') ? { voiceId: req.body.voiceId ?? null } : {}) });
    res.json(await detail(req));
  }));

  router.post('/projects/:id/cast/:castId/looks', requireAuth, asyncHandler(async (req, res) => {
    const f = new Fields(req.body);
    const quoteId = f.string('quoteId', { required: true, max: 64 });
    const idempotencyKey = f.string('idempotencyKey', { required: true, max: 64 });
    f.done();
    await createCastLook(db, { userId: req.user.id, projectId: req.params.id, castId: req.params.castId,
      quoteId, idempotencyKey, urlFor });
    res.json(await detail(req));
  }));

  router.post('/projects/:id/confirm-cast', requireAuth, asyncHandler(async (req, res) => {
    const f = new Fields(req.body);
    const quoteId = f.string('quoteId', { required: true, max: 64 });
    const idempotencyKey = f.string('idempotencyKey', { required: true, max: 64 });
    f.done();
    await confirmCast(db, { channelRouter, userId: req.user.id, projectId: req.params.id, quoteId, idempotencyKey, config });
    res.json(await detail(req));
  }));

  // ── §6.5 进行中控制 ──
  const control = (name, fn) => {
    router.post(`/projects/:id/${name}`, requireAuth, asyncHandler(async (req, res) => {
      await fn(db, { userId: req.user.id, projectId: req.params.id });
      res.json(await detail(req));
    }));
  };
  control('pause', pauseProject);
  control('resume', resumeProject);
  control('retry', retryProject);
  control('cancel', cancelProject);

  // ── §6.6 交付后 ──
  router.patch('/projects/:id/segments/:segmentId', requireAuth, asyncHandler(async (req, res) => {
    const f = new Fields(req.body);
    const plot = f.string('plot', { required: true, max: 1000 });
    f.done();
    await updateSegmentPlot(db, { userId: req.user.id, projectId: req.params.id,
      segmentId: req.params.segmentId, plot });
    res.json(await detail(req));
  }));

  router.post('/projects/:id/segments/:segmentId/takes', requireAuth, asyncHandler(async (req, res) => {
    const f = new Fields(req.body);
    const quoteId = f.string('quoteId', { required: true, max: 64 });
    const idempotencyKey = f.string('idempotencyKey', { required: true, max: 64 });
    f.done();
    await createSegmentTake(db, { channelRouter, userId: req.user.id, projectId: req.params.id,
      segmentId: req.params.segmentId, quoteId, idempotencyKey, config });
    res.json(await detail(req));
  }));

  router.put('/projects/:id/segments/:segmentId/selection', requireAuth, asyncHandler(async (req, res) => {
    const f = new Fields(req.body);
    const takeId = f.string('takeId', { required: true, max: 64 });
    f.done();
    await selectSegmentTake(db, { userId: req.user.id, projectId: req.params.id,
      segmentId: req.params.segmentId, takeId });
    res.json(await detail(req));
  }));

  router.get('/projects/:id/download', requireAuth, asyncHandler(async (req, res) => {
    const url = await projectDownload(db, { userId: req.user.id, projectId: req.params.id,
      storage, ttlSeconds: config.storage.signedUrlTtlSeconds });
    res.redirect(302, url);
  }));

  return router;
}

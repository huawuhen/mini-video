// 管理端·作品与失败/待核对处理路由（M3-ADM-03，docs/API.md §8.3）。
// 与渠道/用户管理同一套独立会话（miv_admin）+ 同源 + CSRF（writeGuard）；
// 全部写操作写 admin_audit_logs。限定 /admin 路径挂载，不影响非管理路径的 404 语义。
import { Router } from 'express';
import { asyncHandler } from '../http/middleware.js';
import { Fields } from '../http/validate.js';
import { appError } from '../http/errors.js';
import { createAdminAuth } from '../channels/admin-auth.js';
import * as adminProjects from '../admin/projects.js';

const PAGE_DEFAULT = 20;
const PAGE_MAX = 50;
const PROJECT_STATUSES = ['understanding', 'story_review', 'casting', 'cast_review', 'rendering',
  'composing', 'delivered', 'expired', 'paused', 'failed', 'canceled'];

function pageLimit(req) {
  const raw = req.query.limit === undefined ? PAGE_DEFAULT : Number(req.query.limit);
  if (!Number.isInteger(raw) || raw < 1 || raw > PAGE_MAX) {
    throw appError('VALIDATION_FAILED', undefined, { fields: { limit: `需为 1~${PAGE_MAX} 的整数` } });
  }
  return raw;
}

export function adminProjectsRoutes({ db, config, logger }) {
  const router = Router();
  const auth = createAdminAuth({ config, db });

  router.use('/admin', auth.sessionMiddleware);
  router.use('/admin', auth.requireAdmin);
  router.use('/admin', auth.writeGuard);

  const audit = (req, action, targetType, targetId, detail = {}) => auth.audit({
    adminId: req.admin?.id ?? null, actor: 'admin', action, targetType, targetId: String(targetId ?? ''), detail,
  });

  router.get('/admin/projects', asyncHandler(async (req, res) => {
    const status = typeof req.query.status === 'string' && req.query.status ? req.query.status : undefined;
    if (status && !PROJECT_STATUSES.includes(status)) {
      throw appError('VALIDATION_FAILED', undefined, { fields: { status: '取值不正确' } });
    }
    res.json(await adminProjects.listProjects(db, {
      status,
      userId: typeof req.query.userId === 'string' && req.query.userId ? req.query.userId.trim() : undefined,
      hasUnknown: req.query.hasUnknown === 'true',
      cursor: typeof req.query.cursor === 'string' && req.query.cursor ? req.query.cursor : undefined,
      limit: pageLimit(req),
    }));
  }));

  router.get('/admin/projects/:id', asyncHandler(async (req, res) => {
    res.json(await adminProjects.getProjectDetail(db, { projectId: String(req.params.id) }));
  }));

  // 待核对判定（真实钱账变动，写审计）：outcome + 说明必填，幂等键打开弹窗时生成。
  // 同键同结论重放返回首次结果且不再重复写审计（复审建议 c）。
  router.post('/admin/takes/:id/resolve', asyncHandler(async (req, res) => {
    const fields = new Fields(req.body);
    const body = {
      outcome: fields.oneOf('outcome', ['not_charged', 'charged'], { required: true }),
      note: fields.string('note', { required: true, max: 200 }),
      idempotencyKey: fields.string('idempotencyKey', { required: true, max: 100 }),
    };
    fields.done();
    const { detail, replayed, refundedFen } = await adminProjects.resolveTake(db,
      { takeId: String(req.params.id), ...body, adminId: req.admin.id });
    if (!replayed) {
      await audit(req, 'take.resolve', 'segment_take', req.params.id,
        { outcome: body.outcome, note: body.note, idempotencyKey: body.idempotencyKey, refundedFen });
    }
    res.json(detail);
  }));

  // 后台取消（与用户侧取消同逻辑：退还未消耗冻结，unknown 保持冻结待 resolve）
  router.post('/admin/projects/:id/cancel', asyncHandler(async (req, res) => {
    const fields = new Fields(req.body);
    const body = { reason: fields.string('reason', { required: true, max: 200 }) };
    fields.done();
    try {
      const { detail, refundedFen, frozenFen } = await adminProjects.cancelProjectAdmin(db, { projectId: String(req.params.id) });
      await audit(req, 'project.cancel', 'project', req.params.id,
        { reason: body.reason, refundedFen, frozenFen });
      res.json(detail);
    } catch (err) {
      // 管理端找不到作品用 PROJECT_NOT_FOUND（用户侧 404 语义不变）
      if (err?.code === 'NOT_FOUND') throw appError('PROJECT_NOT_FOUND');
      throw err;
    }
  }));

  return router;
}

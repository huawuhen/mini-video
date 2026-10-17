// 报价路由（docs/API.md §3）：POST /quotes、POST /quotes/estimate。只做校验与编排，计价在 wallet/pricing.js。
import { Router } from 'express';
import { requireAuth } from '../auth/session.js';
import { asyncHandler } from '../http/middleware.js';
import { Fields } from '../http/validate.js';
import { createQuote, estimateQuote, QUOTE_KINDS } from '../wallet/pricing.js';

export function quoteRoutes({ db }) {
  const router = Router();

  router.post('/quotes/estimate', requireAuth, asyncHandler(async (req, res) => {
    const f = new Fields(req.body);
    const qualityTierId = f.string('qualityTierId', { required: true, min: 1, max: 64 });
    const styleId = f.string('styleId', { required: true, min: 1, max: 64 });
    const characterIds = f.stringArray('characterIds', { maxItems: 50 }) ?? [];
    f.done();
    const result = await db.tx((t) => estimateQuote(t, { userId: req.user.id, qualityTierId, styleId, characterIds }));
    res.json(result);
  }));

  router.post('/quotes', requireAuth, asyncHandler(async (req, res) => {
    const f = new Fields(req.body);
    const kind = f.oneOf('kind', Object.keys(QUOTE_KINDS), { required: true });
    const projectId = f.string('projectId', { max: 64 });
    const characterId = f.string('characterId', { max: 64 });
    const styleId = f.string('styleId', { max: 64 });
    const segmentId = f.string('segmentId', { max: 64 });
    f.done();
    const definition = QUOTE_KINDS[kind];
    const values = { projectId, characterId, styleId, segmentId };
    for (const name of definition.fields) {
      if (!values[name]) f.errors[name] = '必填';
    }
    f.done();
    const request = { kind };
    for (const name of definition.fields) request[name] = values[name];
    res.json(await db.tx((t) => createQuote(t, { userId: req.user.id, request })));
  }));

  return router;
}

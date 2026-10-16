import { Router } from 'express';
import { getCatalog, listVoices, VOICE_CATEGORY_NAMES } from '../catalog/service.js';
import { asyncHandler } from '../http/middleware.js';
import { Fields } from '../http/validate.js';

/** GET /catalog、GET /voices（无需登录，docs/API.md §2）。 */
export function catalogRoutes({ db, urlFor }) {
  const router = Router();
  router.get('/catalog', asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'public, max-age=60');
    res.json(await getCatalog(db, { urlFor }));
  }));
  router.get('/voices', asyncHandler(async (req, res) => {
    const fields = new Fields(req.query);
    const category = fields.oneOf('category', Object.keys(VOICE_CATEGORY_NAMES));
    fields.done();
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ items: await listVoices(db, { category, urlFor }) });
  }));
  return router;
}

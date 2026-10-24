// 数字资产库路由（docs/API.md §5）。只做参数校验与编排，业务在 characters/service.js。
import { Router } from 'express';
import { requireAuth } from '../auth/session.js';
import { asyncHandler } from '../http/middleware.js';
import { Fields } from '../http/validate.js';
import { getSettings } from '../catalog/service.js';
import {
  createCharacter, createLookVersion, deleteCharacter, getCharacterDetail,
  listCharacters, replacePhotos, selectLookVersion, updateCharacter,
} from '../characters/service.js';

async function maxPhotos(db) {
  const settings = await getSettings(db);
  return settings.max_character_photos ?? 5;
}

export function characterRoutes({ db, urlFor, channelRouter = null }) {
  const router = Router();

  router.get('/characters', requireAuth, asyncHandler(async (req, res) => {
    res.json(await listCharacters(db, { userId: req.user.id, urlFor }));
  }));

  router.post('/characters', requireAuth, asyncHandler(async (req, res) => {
    const f = new Fields(req.body);
    const name = f.string('name', { required: true, min: 1, max: 20 });
    const description = f.string('description', { max: 500 });
    const defaultVoiceId = f.string('defaultVoiceId', { max: 64 });
    const tags = f.stringArray('tags', { maxItems: 10, maxLength: 20 });
    const photoUploadIds = f.stringArray('photoUploadIds', { maxItems: 5, maxLength: 64 }) ?? [];
    f.done();
    const character = await createCharacter(db, {
      userId: req.user.id,
      input: { name, description, defaultVoiceId, tags: tags ?? [], photoUploadIds },
      urlFor,
    });
    res.status(201).json(character);
  }));

  router.get('/characters/:id', requireAuth, asyncHandler(async (req, res) => {
    res.json(await getCharacterDetail(db, { userId: req.user.id, id: req.params.id, urlFor }));
  }));

  router.patch('/characters/:id', requireAuth, asyncHandler(async (req, res) => {
    const f = new Fields(req.body);
    const name = f.string('name', { min: 1, max: 20 });
    const description = f.string('description', { max: 500 });
    const defaultVoiceId = f.string('defaultVoiceId', { max: 64 });
    const tags = f.stringArray('tags', { maxItems: 10, maxLength: 20 });
    f.done();
    // defaultVoiceId 显式传 null 表示清除；Fields 对 null 返回 undefined，需要在原文里识别
    const patch = {
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(tags !== undefined ? { tags } : {}),
      ...(Object.prototype.hasOwnProperty.call(req.body, 'defaultVoiceId')
        ? { defaultVoiceId: req.body.defaultVoiceId ?? null }
        : {}),
    };
    res.json(await updateCharacter(db, { userId: req.user.id, id: req.params.id, patch, urlFor }));
  }));

  router.put('/characters/:id/photos', requireAuth, asyncHandler(async (req, res) => {
    // 资源归属（404）在 service 内先于参数校验；uploadIds 的 1~5 张限制也在 service 里按资源校验
    const f = new Fields(req.body);
    const uploadIds = f.stringArray('uploadIds', { maxItems: 5, maxLength: 64 });
    f.done();
    res.json(await replacePhotos(db, {
      userId: req.user.id, id: req.params.id, uploadIds, maxPhotos: await maxPhotos(db), urlFor,
    }));
  }));

  router.post('/characters/:id/looks/:styleId/versions', requireAuth, asyncHandler(async (req, res) => {
    const f = new Fields(req.body);
    const quoteId = f.string('quoteId', { required: true, max: 64 });
    const idempotencyKey = f.string('idempotencyKey', { required: true, min: 8, max: 64 });
    f.done();
    const { version } = await createLookVersion(db, { channelRouter,
      userId: req.user.id, characterId: req.params.id, styleId: req.params.styleId,
      quoteId, idempotencyKey, urlFor,
    });
    // 重放返回同一个版本（同 id），不额外加字段
    res.status(202).json(version);
  }));

  router.put('/characters/:id/looks/:styleId/selection', requireAuth, asyncHandler(async (req, res) => {
    const f = new Fields(req.body);
    const versionId = f.string('versionId', { required: true, max: 64 });
    f.done();
    res.json(await selectLookVersion(db, {
      userId: req.user.id, characterId: req.params.id, styleId: req.params.styleId, versionId, urlFor,
    }));
  }));

  router.delete('/characters/:id', requireAuth, asyncHandler(async (req, res) => {
    res.json(await deleteCharacter(db, { userId: req.user.id, id: req.params.id }));
  }));

  return router;
}

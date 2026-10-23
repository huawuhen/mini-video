// 片段串行生成链（docs/ARCHITECTURE.md §4，用户 2026-10-19 决定：全部片段按顺序串行）。
// segment.generate：建 take/gen_task（幂等键 = take id）→ 提交上游（prev_tail 先取上段尾帧）。
// gen.poll：轮询上游 → 成功后下载→render.inspect→转存→提取尾帧→结算该段→入队下一段/拼接。
// 提交结果未知：take/gen_task 置 unknown、金额保持冻结、不自动重提，项目进入 failed（§5② 口径）。
// 交付后 re-take（redelivery）：改过剧情的片段提交前只为这一段重新绑定提示词；明确失败当场退回
// 该笔预占（delivered 没有 retry/cancel 入口）；结算一律用任务创建时写入的下单金额。
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newId } from '../db/ids.js';
import { appError } from '../http/errors.js';
import { PermanentJobError } from '../queue/index.js';
import { createSkillRegistry } from '../engine/skills/index.js';
import { appendEvent, requireProject, transition } from './state.js';
import { refundRetake, settleSegment, videoUnitFen } from './money.js';
import { videoSkuForMapping } from './understand.js';

const SUBMIT_STALE_MS = 10 * 60 * 1000;

/** 上游明确失败写入 take/项目 error 的口径：message 用适配器的中文业务原因（如素材审核不通过），
 * 上游原始信息只进技术详情（providerMessage/providerCode），不展示为业务文案。 */
function upstreamFailure(result) {
  return {
    message: result.error ?? '视频生成失败，请稍后重试',
    ...(result.providerMessage ? { providerMessage: result.providerMessage } : {}),
    ...(result.providerCode ? { providerCode: result.providerCode } : {}),
  };
}

// 按视频 SKU 的 model 选 Skill（与 bind_prompts 同口径）
const skillRegistry = createSkillRegistry();

export function createSegmentGenerateHandler({ db, logger, config, videoProvider, storage, storyAgent }) {
  return async function segmentGenerate(payload, ctx) {
    const { projectId, idx, takeId } = payload;
    const { rows: current } = await db.query(`SELECT * FROM projects WHERE id = $1`, [projectId]);
    if (!current.length) throw new PermanentJobError('作品不存在');
    const project = current[0];
    // 交付后 re-take（redelivery）也放行：delivered 项目状态保持不变
    if (project.status !== 'rendering' && !(project.status === 'delivered' && payload.redelivery === true)) {
      ctx.logger.info('segment_generate_skip', { projectId, idx, status: project.status });
      return; // 暂停/取消/重分析：链条在此停住（resume 时重新入队）
    }
    const userId = project.user_id;
    const { rows: segmentRows } = await db.query(
      `SELECT * FROM segments WHERE project_id = $1 AND idx = $2`, [projectId, idx]);
    if (!segmentRows.length) throw new PermanentJobError(`片段不存在：idx=${idx}`);
    const segment = segmentRows[0];
    const finalPrompt = segment.final_prompt;
    if (!finalPrompt?.prompt) throw new PermanentJobError('片段缺少最终提示词（bind_prompts 未完成）');

    // 已有在途 take：本 job 是租约丢失后的重复执行，幂等空转（重试场景走 retry 建新 take）
    if (!takeId) {
      const { rows: inFlight } = await db.query(
        `SELECT id, status FROM segment_takes WHERE segment_id = $1 AND status IN ('pending', 'running')`,
        [segment.id],
      );
      if (inFlight.length) {
        ctx.logger.info('segment_generate_inflight', { projectId, idx, takeId: inFlight[0].id });
        return;
      }
    }

    const unit = await videoUnitFen(db, project.tier_mapping_id);
    const amountFen = unit * segment.duration_seconds;
    // prev_tail：调用方在生成前先取上一段尾帧作为普通参考图（尽力而为，不保证首帧衔接）
    let tailRef;
    if (segment.transition === 'prev_tail' && idx > 0) {
      const { rows: prev } = await db.query(
        `SELECT t.last_frame_key FROM segments s
           JOIN segment_takes t ON t.id = s.selected_take_id
          WHERE s.project_id = $1 AND s.idx = $2`, [projectId, idx - 1]);
      tailRef = prev[0]?.last_frame_key ?? undefined;
    }
    const imageRefs = [...(finalPrompt.imageRefs ?? [])];
    if (tailRef) imageRefs.unshift(tailRef); // 尾帧排最前（与提示词 图1 口径一致）

    const takeIdResolved = takeId ?? newId('take');
    await db.tx(async (t) => {
      const { rows: existingTake } = await t.query(
        `SELECT gen_task_id FROM segment_takes WHERE id = $1`, [takeIdResolved]);
      if (takeId && existingTake[0]?.gen_task_id) return; // redelivery：take 与任务已在，幂等
      const { rows: genRows } = await t.query(`SELECT id FROM gen_tasks WHERE idempotency_key = $1`, [takeIdResolved]);
      if (!genRows.length) {
        const { rows: skuRows } = await t.query(
          `SELECT s.sku_code, s.version, s.resolution FROM tier_mappings tm
             JOIN skus s ON s.sku_code = tm.video_sku_code AND s.kind = 'video' AND s.status = 'active'
            WHERE tm.id = $1 ORDER BY s.version DESC LIMIT 1`, [project.tier_mapping_id]);
        const genTaskId = newId('gt');
        await t.query(
          `INSERT INTO segment_takes (id, segment_id, status) VALUES ($1, $2, 'pending')`,
          [takeIdResolved, segment.id],
        );
        await t.query(
          `INSERT INTO gen_tasks (id, user_id, kind, sku_code, sku_version, provider, status, request, idempotency_key)
           VALUES ($1, $2, 'video', $3, $4, 'unassigned', 'created', $5, $6)`,
          [genTaskId, userId, skuRows[0].sku_code, skuRows[0].version, JSON.stringify({
            takeId: takeIdResolved, projectId, segmentId: segment.id, idx,
            prompt: finalPrompt.prompt, imageRefs, audioRefs: finalPrompt.audioRefs ?? [],
            durationSeconds: segment.duration_seconds, ratio: project.ratio,
            videoKey: `users/${userId}/projects/${projectId}/takes/${takeIdResolved}.mp4`,
            lastFrameKey: `users/${userId}/projects/${projectId}/takes/${takeIdResolved}.last.jpg`,
            amountFen, resolution: skuRows[0].resolution ?? '720p',
          }), takeIdResolved], // 幂等键 = take id（docs/ARCHITECTURE.md §4）
        );
        await t.query(`UPDATE segment_takes SET gen_task_id = $2 WHERE id = $1`, [takeIdResolved, genTaskId]);
      }
    });

    const { rows: takeRows } = await db.query(
      `SELECT t.*, gt.id AS gen_task_id, gt.status AS task_status, gt.updated_at AS task_updated_at, gt.request
         FROM segment_takes t LEFT JOIN gen_tasks gt ON gt.id = t.gen_task_id
        WHERE t.id = $1`, [takeIdResolved]);
    const take = takeRows[0];
    if (!take.gen_task_id) throw new PermanentJobError('片段任务缺少 gen_task');
    let request = typeof take.request === 'string' ? JSON.parse(take.request) : take.request;

    if (take.status === 'succeeded' || take.status === 'failed' || take.status === 'unknown') {
      ctx.logger.info('segment_generate_skip_done', { takeId: takeIdResolved, status: take.status });
      return;
    }

    // 复审必改 2：交付后改过剧情的 re-take，提交前只为这一段重新绑定提示词（没改不调 LLM）
    if (request.redelivery === true && storyAgent) {
      request = await rebindRetakePrompt(db, { logger, storyAgent, project, segment, request,
        genTaskId: take.gen_task_id });
    }

    // 提交守卫（同 BE-04）：只有 created → submitting；停滞的 submitting 置 unknown 绝不重提
    const claim = await db.tx(async (t) => {
      const created = await t.query(
        `UPDATE gen_tasks SET status = 'submitting', provider = $2, updated_at = now()
          WHERE id = $1 AND status = 'created' RETURNING id`,
        [take.gen_task_id, videoProvider.id],
      );
      if (created.rows.length) return { claimed: true };
      const { rows: cur } = await t.query(`SELECT status, updated_at FROM gen_tasks WHERE id = $1`,
        [take.gen_task_id]);
      return { claimed: false, status: cur[0].status, updatedAt: cur[0].updated_at };
    });
    if (!claim.claimed) {
      if (claim.status === 'submitting' && Date.now() - claim.updatedAt.getTime() < SUBMIT_STALE_MS) {
        throw new Error('片段任务正在提交中，等待下次检查');
      }
      if (claim.status === 'submitting' || claim.status === 'running' || claim.status === 'unknown') {
        await markTakeUnknown(db, ctx, { take: takeIdResolved, projectId, userId, genTaskId: take.gen_task_id, logger });
        return;
      }
      ctx.logger.info('segment_generate_skip_task', { takeId: takeIdResolved, status: claim.status });
      return;
    }
    await db.tx(async (t) => t.query(`UPDATE segment_takes SET status = 'running' WHERE id = $1 AND status = 'pending'`,
      [takeIdResolved]));

    await ctx.extendLease?.();
    let submitted;
    try {
      // 复审必改 3：上游只能访问签名 URL；gen_tasks.request 里保存 key（过期后重签）
      const toUrls = (keys) => Promise.all((keys ?? []).map((key) => storage.signedUrl(key,
        { ttlSeconds: config.projects.refUrlTtlSeconds })));
      // redelivery 的请求只存形象 key（createSegmentTake / 重绑定均不含尾帧），提交前按当前
      // 上一段选中 take 的尾帧补在最前（与提示词 图1 口径一致）；首次生成的请求建任务时已带尾帧
      const submitImageRefs = request.redelivery === true && tailRef
        ? [tailRef, ...(request.imageRefs ?? []).filter((key) => key !== tailRef)]
        : request.imageRefs;
      const prepared = videoProvider.prepare({
        prompt: request.prompt,
        imageRefs: await toUrls(submitImageRefs),
        audioRefs: await toUrls(request.audioRefs),
        durationSeconds: request.durationSeconds, ratio: request.ratio, resolution: request.resolution,
      }, { durations: request.allowedDurations });
      submitted = await videoProvider.submit(prepared, { idempotencyKey: takeIdResolved });
    } catch (error) {
      if (error.retryable === true) {
        await db.tx(async (t) => t.query(
          `UPDATE gen_tasks SET status = 'created', updated_at = now() WHERE id = $1 AND status = 'submitting'`,
          [take.gen_task_id]));
        await db.tx(async (t) => t.query(
          `UPDATE segment_takes SET status = 'pending' WHERE id = $1 AND status = 'running'`, [takeIdResolved]));
        throw error; // 明确未提交：回退交队列重试
      }
      await markTakeUnknown(db, ctx, { take: takeIdResolved, projectId, userId, genTaskId: take.gen_task_id, logger });
      return;
    }

    // 明确失败（上游拒绝提交，本就没有 upstreamId）必须先于 unknown 判定——
    // 否则会把「明确失败」误记成 unknown：金额冻结、交付后 re-take 也没有退款入口
    if (submitted.status === 'failed') {
      await failSegment(db, ctx, { takeId: takeIdResolved, projectId, userId, genTaskId: take.gen_task_id,
        keepDelivered: request.redelivery === true, amountFen: request.amountFen,
        error: upstreamFailure(submitted), logger });
      return;
    }
    if (submitted.status === 'unknown' || !submitted.upstreamId) {
      await markTakeUnknown(db, ctx, { take: takeIdResolved, projectId, userId, genTaskId: take.gen_task_id, logger });
      return;
    }
    await db.tx(async (t) => {
      await t.query(
        `UPDATE gen_tasks SET status = 'running', upstream_id = $2, next_poll_at = now() + make_interval(secs => $3),
           updated_at = now() WHERE id = $1`,
        [take.gen_task_id, String(submitted.upstreamId), config.projects.genPollIntervalSeconds]);
      await t.query(`UPDATE segment_takes SET status = 'running' WHERE id = $1`, [takeIdResolved]);
    });
    await ctx.enqueue({ type: 'gen.poll', payload: { takeId: takeIdResolved },
      delaySeconds: config.projects.genPollIntervalSeconds });
    ctx.logger.info('segment_submitted', { takeId: takeIdResolved, upstreamId: String(submitted.upstreamId) });
  };
}

/** take unknown：金额保持冻结、不重提；项目进入 failed（§5② 口径，retry 空转）。 */
async function markTakeUnknown(db, ctx, { take, projectId, userId, genTaskId, logger }) {
  await db.tx(async (t) => {
    await t.query(`UPDATE gen_tasks SET status = 'unknown', updated_at = now() WHERE id = $1`, [genTaskId]);
    await t.query(`UPDATE segment_takes SET status = 'unknown' WHERE id = $1`, [take]);
    await transition(t, { projectId, userId, from: ['rendering'], to: 'failed',
      error: { code: 'TAKE_UNKNOWN', message: '片段提交结果未知，金额已冻结，请联系客服处理', step: 'rendering' },
      progress: { percent: 0, message: '片段处理出现异常' } }).catch((error) => {
      if (error?.code !== 'PROJECT_STATE_INVALID') throw error;
    });
  });
  logger.error('segment_take_unknown', { take, projectId });
}

/** 交付后 re-take 的剧情重绑定（复审必改 2）：PATCH plot 只改展示列，提交前在这里生效——
 * plot 与上次绑定时不一致（final_prompt.plot 为绑定时的剧情快照，旧行回退到理解输出），
 * 就用 storyAgent.bindPrompts 只为这一段重新生成镜头时间线与最终提示词：
 * startState 取上一段绑定时的 endState、bible 从 projects.story.raw、形象/音色沿用已锁定的、
 * 对白以 segments.dialogue 为准。绑定走引擎的修复重试与确定性兜底；意外失败沿用旧提示词不阻塞。 */
async function rebindRetakePrompt(db, { logger, storyAgent, project, segment, request, genTaskId }) {
  const raw = project.story?.raw;
  if (!raw) return request;
  const rawSegment = raw.segments?.[segment.idx] ?? {};
  const boundPlot = typeof segment.final_prompt?.plot === 'string'
    ? segment.final_prompt.plot : rawSegment.plot;
  if (segment.plot === boundPlot) return request; // 没改剧情：不重复调 LLM

  const { rows: styleRows } = await db.query(
    `SELECT name, prompt_hint AS "promptHint" FROM styles WHERE id = $1`, [project.style_id]);
  const { rows: castRows } = await db.query(
    `SELECT pc.id, pc.voice_id, lv.image_key AS look_image_key, v.ref_audio_key
       FROM project_cast pc
       LEFT JOIN look_versions lv ON lv.id = pc.look_version_id
       LEFT JOIN voices v ON v.id = pc.voice_id
      WHERE pc.project_id = $1 ORDER BY pc.idx`, [project.id]);
  const cast = castRows.map((row) => ({
    id: row.id,
    ...(row.look_image_key ? { lookImageKey: row.look_image_key } : {}),
    ...(row.ref_audio_key ? { refAudioKey: row.ref_audio_key } : {}),
  }));
  const { rows: countRows } = await db.query(
    `SELECT count(*)::int AS n FROM segments WHERE project_id = $1`, [project.id]);
  const voicesEnabled = countRows[0].n >= 2;
  // 输入数组下标 0 放上一段占位（bindPrompts 的 startState 取数组前一项的 endState），
  // 目标段落在自己的位置上，usePrevTail / startState 与整链绑定的口径一致
  const bindSegments = [];
  if (segment.idx > 0) {
    const { rows: prevRows } = await db.query(
      `SELECT final_prompt FROM segments WHERE project_id = $1 AND idx = $2`,
      [project.id, segment.idx - 1]);
    bindSegments.push({ endState: prevRows[0]?.final_prompt?.endState ?? '' });
  }
  bindSegments.push({
    ...rawSegment,
    durationSeconds: segment.duration_seconds,
    transition: segment.transition,
    plot: segment.plot,
    dialogue: segment.dialogue ?? [],
    castIds: segment.cast_ids ?? [],
  });
  let entry;
  try {
    const sku = await videoSkuForMapping(db, project.tier_mapping_id);
    const bound = await storyAgent.bindPrompts({
      style: styleRows[0] ?? {}, ratio: project.ratio, segments: bindSegments, cast,
      bible: raw.bible, voicesEnabled, skillId: skillRegistry.forModel(sku.model).id,
    });
    entry = bound[bindSegments.length - 1];
  } catch (error) {
    logger.error('segment_rebind_failed', { takeId: request.takeId, projectId: project.id,
      err: String(error.message).slice(0, 200) });
    return request; // 不阻塞：沿用旧提示词
  }
  const finalPrompt = {
    prompt: entry.prompt, imageRefs: entry.imageRefs, audioRefs: entry.audioRefs,
    usePrevTail: entry.usePrevTail, droppedRefs: entry.droppedRefs ?? 0,
    startState: entry.startState, endState: entry.endState, shots: entry.shots,
    skillId: entry.skillId, skillVersion: entry.skillVersion, degraded: entry.degraded,
    plot: segment.plot, // 绑定时的剧情快照：下一次改动以此为基准比对
  };
  const updated = { ...request, prompt: entry.prompt, imageRefs: entry.imageRefs, audioRefs: entry.audioRefs };
  await db.tx(async (t) => {
    await t.query(`UPDATE segments SET final_prompt = $2 WHERE id = $1`,
      [segment.id, JSON.stringify(finalPrompt)]);
    await t.query(`UPDATE gen_tasks SET request = $2, updated_at = now() WHERE id = $1`,
      [genTaskId, JSON.stringify(updated)]);
  });
  logger.info('segment_rebound', { takeId: request.takeId, projectId: project.id, degraded: entry.degraded });
  return updated;
}

/** 片段失败（上游业务失败/inspect 不通过）：首次生成的该段预占**保持冻结**，重试成功后照常结算、
 * 取消时按未结算部分退回（§5① A 口径——「失败即退回+重试免费」会让重试段无钱可结算）。
 * 交付后 re-take（keepDelivered）当场退回该笔预占（复审必改 1：delivered 没有 retry/cancel
 * 入口，不退就永久冻结；幂等键按 takeId 区分，重复执行只退一次）。 */
export async function failSegment(db, ctx, { takeId, projectId, userId, genTaskId, keepDelivered,
  amountFen, error, logger }) {
  await db.tx(async (t) => {
    const claimed = await t.query(
      `UPDATE segment_takes SET status = 'failed', error = $2 WHERE id = $1 AND status IN ('running', 'pending') RETURNING id`,
      [takeId, JSON.stringify(error)],
    );
    if (claimed.rows.length) {
      await t.query(`UPDATE gen_tasks SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`,
        [genTaskId, JSON.stringify(error)]);
      if (keepDelivered) {
        // 复审必改 4：退回金额同样取下单时写入的 amountFen；缺失属内部不变量被破坏，记错误日志
        if (Number.isSafeInteger(amountFen) && amountFen > 0) {
          await refundRetake(t, { userId, projectId, takeId, amountFen });
        } else {
          logger.error('redelivery_refund_missing_amount', { takeId, projectId, amountFen });
        }
      }
    }
    if (!keepDelivered) {
      await transition(t, { projectId, userId, from: ['rendering'], to: 'failed',
        error: { code: 'SEGMENT_FAILED', message: error.message ?? '片段生成失败，可重试', step: 'rendering' },
        progress: { percent: 0, message: '片段生成失败' } }).catch((error) => {
        if (error?.code !== 'PROJECT_STATE_INVALID') throw error;
      });
    } else {
      logger.warn('redelivery_take_failed', { takeId, projectId });
    }
  });
  logger.warn('segment_failed', { takeId, projectId, reason: error.message });
}

/** 轮询上游（gen.poll）：running → 退避重排；成功 → 下载 → inspect → 转存 → 尾帧 → 结算 → 下一段；
 * 失败 → 首次生成保持冻结待重试（§5①）、交付后 re-take 当场退回该笔预占；unknown → 冻结待对账（§5②）。
 * 网络类异常直接抛出交队列退避。 */
export function createGenPollHandler({ db, logger, config, videoProvider, storage, render, downloadToTempFile }) {
  return async function genPoll(payload, ctx) {
    const { takeId } = payload;
    const { rows } = await db.query(
      `SELECT t.id AS take_id, t.status AS take_status, t.segment_id, gt.user_id, gt.status AS task_status,
              gt.upstream_id, gt.id AS gen_task_id, gt.request
         FROM segment_takes t JOIN gen_tasks gt ON gt.id = t.gen_task_id
        WHERE t.id = $1`, [takeId]);
    const take = rows[0];
    if (!take) throw new PermanentJobError('片段任务不存在');
    if (take.take_status !== 'running' || take.task_status !== 'running') {
      ctx.logger.info('gen_poll_skip', { takeId, takeStatus: take.take_status, taskStatus: take.task_status });
      return;
    }
    const request = typeof take.request === 'string' ? JSON.parse(take.request) : take.request;
    const { projectId } = request;
    const { rows: projectRows } = await db.query(
      `SELECT status, ratio, tier_mapping_id, user_id, style_id FROM projects WHERE id = $1`, [projectId]);
    const project = projectRows[0];
    if (!project) throw new PermanentJobError('作品不存在');

    // 复审必改 4：轮询超时（从提交时刻起算，默认 7200 秒 = 120 分钟，用户 2026-10-20 指定）。
    // 超时按结果未知处理：金额保持冻结、不重提、项目 failed(TAKE_UNKNOWN)，等 M2 对账。
    const elapsed = Number((await db.query(
      `SELECT extract(epoch FROM (now() - created_at))::int AS seconds FROM gen_tasks WHERE id = $1`,
      [take.gen_task_id],
    )).rows[0]?.seconds ?? 0);
    const timeoutSeconds = config.projects.genPollTimeoutSeconds;
    // M2-BE-01：到上限 80% 记一次预警（M0 实测渠道排队可达 44 分钟，高峰可能触线）；
    // result.warnedNearTimeout 原子置位，避免每次轮询重复报警（成功覆写 result 时标记随之消失，无影响）
    if (elapsed > timeoutSeconds * 0.8 && elapsed <= timeoutSeconds) {
      const { rowCount } = await db.query(
        `UPDATE gen_tasks SET result = COALESCE(result, '{}'::jsonb) || '{"warnedNearTimeout":true}'::jsonb
          WHERE id = $1 AND COALESCE(result ->> 'warnedNearTimeout', 'false')::boolean IS NOT TRUE`,
        [take.gen_task_id],
      );
      if (rowCount) logger.warn('gen_poll_near_timeout', { takeId, elapsedSeconds: elapsed, timeoutSeconds });
    }
    if (elapsed > timeoutSeconds) {
      logger.error('gen_poll_timeout', { takeId, seconds: elapsed });
      await markTakeUnknown(db, ctx, { take: takeId, projectId, userId: take.user_id,
        genTaskId: take.gen_task_id, logger });
      return;
    }

    await ctx.extendLease?.();
    let result;
    try {
      result = await videoProvider.query(take.upstream_id);
    } catch (error) {
      throw error; // 网络类：交队列按退避重试（上游状态未知不重提，仅继续轮询）
    }
    if (result.status === 'running') {
      await db.tx(async (t) => t.query(
        `UPDATE gen_tasks SET next_poll_at = now() + make_interval(secs => $2), updated_at = now() WHERE id = $1`,
        [take.gen_task_id, config.projects.genPollIntervalSeconds]));
      await ctx.enqueue({ type: 'gen.poll', payload: { takeId }, delaySeconds: config.projects.genPollIntervalSeconds });
      return;
    }
    if (result.status === 'unknown') {
      await markTakeUnknown(db, ctx, { take: takeId, projectId, userId: take.user_id, genTaskId: take.gen_task_id, logger });
      return;
    }

    // 复审必改 4：结算/退回一律用任务创建时写入的下单金额（segment.generate / createSegmentTake
    // 都写进 gen_tasks.request.amountFen），不在结算时重新查价——生成中途调价（SKU 新版本生效）
    // 不再造成结算额与冻结额不一致（调高结算失败、调低冻结残留）。
    const amountFen = request.amountFen;
    if (!Number.isSafeInteger(amountFen) || amountFen <= 0) {
      throw new PermanentJobError(`片段任务缺少下单金额 amountFen：take=${takeId}`);
    }

    if (result.status === 'failed') {
      await failSegment(db, ctx, { takeId, projectId, userId: take.user_id, genTaskId: take.gen_task_id,
        keepDelivered: request.redelivery === true, amountFen,
        error: upstreamFailure(result), logger });
      return;
    }

    // succeeded：下载到本地 → 基础技术检查 → 转存 → 尾帧 → 结算 → 下一段/拼接
    const workDir = await mkdtemp(join(tmpdir(), 'miv-take-'));
    const localPath = join(workDir, 'take.mp4');
    try {
      const output = (result.outputs ?? []).find((item) => item.kind === 'video') ?? result.outputs?.[0];
      if (!output?.url) {
        await markTakeUnknown(db, ctx, { take: takeId, projectId, userId: take.user_id,
          genTaskId: take.gen_task_id, logger });
        return; // 成功状态拿不到地址：结果未知
      }
      await downloadToTempFile(output.url, localPath, { timeoutMs: config.projects.videoDownloadTimeoutMs });
      await ctx.extendLease?.();
      const inspection = await render.inspect(localPath, {
        durationSeconds: request.durationSeconds, ratio: request.ratio,
        resolution: request.resolution, expectAudio: true,
      });
      if (!inspection.ok) {
        const reason = inspection.issues.map((issue) => issue.message).join('；');
        await failSegment(db, ctx, { takeId, projectId, userId: take.user_id,
          genTaskId: take.gen_task_id, keepDelivered: request.redelivery === true,
          amountFen, error: { message: `片段技术检查未通过：${reason}` }, logger });
        return;
      }
      await ctx.extendLease?.();
      await storage.put(request.videoKey, await readFile(localPath));
      const lastFramePath = await render.extractLastFrame(localPath, { workDir });
      await storage.put(request.lastFrameKey, await readFile(lastFramePath));

      const redelivery = request.redelivery === true;
      const settled = await db.tx(async (t) => {
        const claimed = await t.query(
          `UPDATE segment_takes SET status = 'succeeded', video_key = $2, last_frame_key = $3
            WHERE id = $1 AND status = 'running' RETURNING id`,
          [takeId, request.videoKey, request.lastFrameKey],
        );
        if (!claimed.rows.length) return false; // 输掉竞争：不动钱
        await t.query(`UPDATE gen_tasks SET status = 'succeeded', result = $2, updated_at = now() WHERE id = $1`,
          [take.gen_task_id, JSON.stringify({ videoKey: request.videoKey })]);
        await settleSegment(t, { userId: take.user_id, projectId, takeId, amountFen });
        if (redelivery) {
          // 交付后重生成：新增候选成功 → 直接切换选中（旧 take 保留），按新 render 重新拼接
          await t.query(`UPDATE segments SET selected_take_id = $2 WHERE id = $1`,
            [take.segment_id, takeId]);
        } else {
          await t.query(`UPDATE segments SET selected_take_id = $2 WHERE id = $1 AND selected_take_id IS NULL`,
            [take.segment_id, takeId]);
        }
        return true;
      });
      if (!settled) return;
      const { rows: countRows } = await db.query(
        `SELECT count(*)::int AS total,
                SUM(CASE WHEN t.status = 'succeeded' THEN 1 ELSE 0 END)::int AS done
           FROM segments s LEFT JOIN segment_takes t ON t.id = s.selected_take_id
          WHERE s.project_id = $1`, [projectId]);
      const { total, done } = countRows[0];
      const { rowCount: stillRendering } = await db.query(
        `UPDATE projects SET progress = $2, updated_at = now()
          WHERE id = $1 AND status = 'rendering'`,
        [projectId, JSON.stringify({ percent: 45 + Math.round((done / total) * 45),
          message: `正在生成片段 ${Math.min(done + 1, total)}/${total}` })]);
      if (stillRendering) {
        await appendEvent(db, { projectId,
          progress: { percent: 45 + Math.round((done / total) * 45),
            message: `正在生成片段 ${Math.min(done + 1, total)}/${total}` }, changed: ['segments'] });
      }
      logger.info('segment_succeeded', { takeId, projectId, done, total });
      if (redelivery) {
        // 交付后重生成：状态保持 delivered，重新拼接走新的 render 记录
        await appendEvent(db, { projectId,
          progress: { percent: 100, message: '正在重新拼接' }, changed: ['segments'] });
        await ctx.enqueue({ type: 'project.compose', payload: { projectId },
          dedupeKey: `project:compose:${projectId}:retake:${takeId}` });
        return;
      }
      if (done >= total) {
        await db.tx(async (t) => transition(t, { projectId, userId: take.user_id,
          from: ['rendering'], to: 'composing',
          progress: { percent: 95, message: '正在拼接成片' }, changed: ['segments'] }).catch((error) => {
          if (error?.code !== 'PROJECT_STATE_INVALID') throw error;
        }));
        await ctx.enqueue({ type: 'project.compose', payload: { projectId },
          dedupeKey: `project:compose:${projectId}` });
      } else if (project.status === 'rendering') {
        await ctx.enqueue({ type: 'segment.generate', payload: { projectId, idx: request.idx + 1 } });
      }
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  };
}

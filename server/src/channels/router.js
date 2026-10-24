// 渠道路由层（ARCHITECTURE §5.5）：视频 / 图片 / LLM 的调用都经这里。
// - pick(kind)：提交前选「生效渠道」（无 → NO_ACTIVE_CHANNEL，用户侧文案「服务暂时不可用」）。
// - forTask(channelId)：轮询 / 取消 / 对账回到任务提交时绑定的渠道（即使已停用/软删除仍可轮询，
//   只要驱动存在；驱动缺失时渠道被跳过、任务保持原状，不退款不重提）。
// - 统一真实请求结果统计（channel_events，只记实际发生的请求）。
// 业务代码只看到驱动实例（统一接口），不认识渠道名、驱动名、厂商名。
import { appError } from '../http/errors.js';

const NO_ACTIVE_MESSAGE = {
  video: '视频生成服务暂时不可用，请稍后再试',
  image: '图片生成服务暂时不可用，请稍后再试',
  llm: '故事理解服务暂时不可用，请稍后再试',
};

/**
 * @param deps 驱动实例共用的注入（loadReference / downloadImage / fetchImpl 缺省走全局 fetch
 *             与 net.safeFetch 的包装，由 worker 装配传入）
 */
export function createChannelRouter({ db, service, registry, logger, deps = {} }) {

  /** 提交前选生效渠道：{ channelId, driverInstance }；无生效渠道 → 503 NO_ACTIVE_CHANNEL。 */
  async function pick(kind, { capability = '*' } = {}) {
    const row = await service.pickRow(kind, { capability });
    if (!row) {
      logger?.error?.('no_active_channel', { kind, capability });
      throw appError('NO_ACTIVE_CHANNEL', NO_ACTIVE_MESSAGE[kind] ?? NO_ACTIVE_MESSAGE.video);
    }
    const instance = service.instanceForRow(row, deps);
    return { channelId: row.id, channel: row, instance };
  }

  /** 任务绑定的渠道（提交时写入 gen_tasks.channel_id）：回原渠道轮询 / 对账。 */
  async function forTask(channelId) {
    const { rows } = await db.query(`SELECT * FROM provider_channels WHERE id = $1`, [channelId]);
    const row = rows[0];
    if (!row) {
      throw new Error(`任务绑定的渠道不存在：${channelId}（在途任务保持原状，不退款不重提）`);
    }
    if (!registry.has(row.driver)) {
      // 驱动缺失：该渠道被跳过——任务保持原状（继续保留 unknown/running），不退款、不重提
      logger?.error?.('channel_driver_missing_skipped', { channelId, driver: row.driver });
      return { channelId, channel: row, instance: null };
    }
    if (!row.credential_enc) {
      // 软删除且在途已清空（凭证已清除）：驱动实例无法创建，任务保持原状
      logger?.warn?.('channel_credential_cleared', { channelId });
      return { channelId, channel: row, instance: null };
    }
    return { channelId, channel: row, instance: service.instanceForRow(row, deps) };
  }

  const outcomeFor = (status) => {
    if (status === 'running') return 'submitted';
    if (status === 'succeeded') return 'succeeded';
    if (status === 'failed') return 'failed';
    return 'unknown';
  };

  /** 记录一次真实提交的结果（成功/失败/未知），带耗时（供健康度/排队时长参考）。 */
  async function recordSubmission({ channelId, genTaskId, status, latencyMs, errorCode }) {
    await service.recordEvent({ channelId, genTaskId, outcome: outcomeFor(status), latencyMs, errorCode });
  }

  /** 记录一次查询失败（网络抖动，任务仍在渠道侧）。 */
  async function recordQueryFailure({ channelId, genTaskId, errorCode }) {
    await service.recordEvent({ channelId, genTaskId, outcome: 'query_failed', errorCode });
  }

  return { pick, forTask, recordSubmission, recordQueryFailure };
}

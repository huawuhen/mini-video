import { onBeforeUnmount, ref, watch, type Ref } from 'vue';
import { api, type ProjectDetail } from '@/api';
import { isWorkingStatus } from '@/utils/status';

/**
 * 作品实时状态（M2-WEB-01）：SSE（GET /projects/:id/events，浏览器断线自动带 Last-Event-ID 重连）
 * 作为变更信号，收到事件后拉取完整详情；SSE 未连上或断开期间退回轮询兜底（进行中 2 秒，
 * 其余 8 秒，页面隐藏时暂停）。离开页面再回来：EventSource 重建 + 立即对账一次详情。
 */
export function useProjectLive(projectId: Ref<string>) {
  const project = ref<ProjectDetail | null>(null);
  const error = ref('');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let source: EventSource | undefined;
  let stopped = false;

  async function refresh() {
    try {
      project.value = await api.getProject(projectId.value);
      error.value = '';
    } catch (e) {
      error.value = (e as Error).message;
    }
  }
  function schedule() {
    clearTimeout(timer);
    if (stopped) return;
    // SSE 连接健康时一律 30 秒慢对账（变更靠事件推送；实测排队可达 79 分钟，2 秒轮询一个开着
    // 的页面要打几千次详情请求）；SSE 断开期间才回到 2 秒快轮询兜底
    timer = setTimeout(async () => {
      if (!document.hidden) await refresh();
      schedule();
    }, source?.readyState === EventSource.OPEN ? 30_000 : 2000);
  }
  function connect() {
    source?.close();
    source = new EventSource(`/api/v1/projects/${encodeURIComponent(projectId.value)}/events`);
    source.addEventListener('project', () => { void refresh(); });
    source.onopen = () => { void refresh(); };
    source.onerror = () => { /* 浏览器自动重连；期间由轮询兜底 */ };
  }
  const onVisible = () => { if (!document.hidden) void refresh(); };
  watch(projectId, async () => {
    project.value = null;
    await refresh();
    if (!stopped) connect();
    schedule();
  }, { immediate: true });
  document.addEventListener('visibilitychange', onVisible);
  onBeforeUnmount(() => {
    stopped = true;
    clearTimeout(timer);
    source?.close();
    document.removeEventListener('visibilitychange', onVisible);
  });
  return { project, error, refresh };
}

function isBusy(p: ProjectDetail | null) {
  return !!p && (isWorkingStatus(p.status)
    || p.render?.status === 'running'
    || p.segments.some((s) => s.takes.some((t) => t.status === 'running' || t.status === 'pending')));
}

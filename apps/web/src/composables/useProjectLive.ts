import { onBeforeUnmount, ref, watch, type Ref } from 'vue';
import { api, type ProjectDetail } from '@/api';
import { isWorkingStatus } from '@/utils/status';

/**
 * 作品实时状态。当前用轮询（后台推进中 2 秒一次，其余 8 秒，页面隐藏时暂停）。
 * 后端 SSE（GET /projects/:id/events）就绪后在这里替换实现，页面无需改动（M2-WEB-01）。
 */
export function useProjectLive(projectId: Ref<string>) {
  const project = ref<ProjectDetail | null>(null);
  const error = ref('');
  let timer: ReturnType<typeof setTimeout> | undefined;
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
    timer = setTimeout(async () => {
      if (!document.hidden) await refresh();
      schedule();
    }, project.value && isBusy(project.value) ? 2000 : 8000);
  }
  watch(projectId, async () => { project.value = null; await refresh(); schedule(); }, { immediate: true });
  onBeforeUnmount(() => { stopped = true; clearTimeout(timer); });
  return { project, error, refresh };
}

function isBusy(p: ProjectDetail) {
  return isWorkingStatus(p.status)
    || p.render?.status === 'running'
    || p.segments.some((s) => s.takes.some((t) => t.status === 'running' || t.status === 'pending'));
}

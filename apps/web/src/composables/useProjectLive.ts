import { onBeforeUnmount, ref, watch, type Ref } from 'vue';
import { api, type ProjectDetail } from '@/api';
import { isActiveStatus } from '@/utils/status';

/**
 * 项目实时状态。当前用轮询（生成中 2 秒一次，其余 6 秒，页面隐藏时暂停）。
 * 后端 SSE（GET /projects/:id/events）就绪后在这里替换实现，页面无需改动。
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
    const busy = project.value && (isActiveStatus(project.value.status) || hasRunningItems(project.value));
    timer = setTimeout(async () => {
      if (!document.hidden) await refresh();
      schedule();
    }, busy ? 2000 : 6000);
  }
  watch(projectId, async () => { project.value = null; await refresh(); schedule(); }, { immediate: true });
  onBeforeUnmount(() => { stopped = true; clearTimeout(timer); });
  return { project, error, refresh };
}

function hasRunningItems(p: ProjectDetail) {
  return p.assets.some((a) => a.versions.some((v) => v.status === 'running' || v.status === 'pending'))
    || p.shots.some((s) => s.takes.some((t) => t.status === 'running' || t.status === 'pending'));
}

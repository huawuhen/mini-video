<script setup lang="ts">
import { computed, ref } from 'vue';
import { showToast } from 'vant';
import { api, type ProjectDetail } from '@/api';
import MediaPlaceholder from '@/components/MediaPlaceholder.vue';

const props = defineProps<{ project: ProjectDetail }>();
const emit = defineEmits<{ changed: [] }>();
const latest = computed(() => props.project.renders[0]);
// 竖屏视频按视口高度限制宽度，避免手机/PC 上播放器超出一屏
const playerMaxWidth = computed(() => {
  const [w, h] = props.project.options.ratio.split(':').map(Number);
  return h > w ? `min(420px, calc(70vh * ${w} / ${h}))` : '100%';
});
const subtitles = ref(true);
const rerendering = ref(false);

async function rerender() {
  rerendering.value = true;
  try {
    await api.createRender(props.project.id, { subtitles: subtitles.value }, crypto.randomUUID());
    showToast('已重新合成');
    emit('changed');
  } catch (e) { showToast((e as Error).message); } finally { rerendering.value = false; }
}
function download() { showToast('演示环境暂不支持下载，接入后端后可用'); }
</script>

<template>
  <div v-if="!latest" class="miv-card"><van-loading vertical>正在合成成片…</van-loading></div>
  <div v-else class="delivery">
    <div class="player" :style="{ maxWidth: playerMaxWidth }">
      <video v-if="latest.videoUrl" :src="latest.videoUrl" :poster="latest.coverUrl" controls playsinline />
      <MediaPlaceholder v-else :src="latest.coverUrl" :ratio="project.options.ratio">
        <van-icon name="play-circle-o" class="play" />
      </MediaPlaceholder>
    </div>
    <div class="side">
      <div class="miv-card">
        <h2>{{ project.plan?.title || project.title }}</h2>
        <p class="miv-hint">时长 {{ latest.durationSeconds }} 秒 · {{ project.options.ratio }}</p>
        <div class="buttons">
          <van-button type="primary" block icon="down" @click="download">下载成片</van-button>
          <van-button block plain icon="share-o" disabled>分享（即将上线）</van-button>
        </div>
      </div>
      <div class="miv-card">
        <div class="miv-section-title">调整后重新合成</div>
        <van-cell title="显示字幕" :border="false"><template #right-icon><van-switch v-model="subtitles" size="20" /></template></van-cell>
        <van-cell title="背景音乐" value="即将上线" :border="false" />
        <van-button block plain type="primary" :loading="rerendering" @click="rerender">重新合成（不收模型费）</van-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.delivery { display: grid; gap: var(--miv-space-4); }
.player { max-width: 420px; width: 100%; margin: 0 auto; }
.player video { width: 100%; border-radius: var(--miv-radius-md); background: #000; }
.play { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); font-size: 56px; color: rgba(255, 255, 255, 0.9); }
.side { display: flex; flex-direction: column; gap: var(--miv-space-3); }
h2 { font-size: 18px; margin-bottom: var(--miv-space-1); }
.buttons { display: flex; flex-direction: column; gap: var(--miv-space-2); margin-top: var(--miv-space-3); }
@media (min-width: 1024px) { .delivery { grid-template-columns: minmax(0, 420px) 1fr; align-items: start; } .player { margin: 0; } }
</style>

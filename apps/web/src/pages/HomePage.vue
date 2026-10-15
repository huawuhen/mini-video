<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api, type Catalog, type ProjectSummary } from '@/api';
import ProjectCard from '@/components/ProjectCard.vue';
import { useAuthStore } from '@/stores/auth';

const router = useRouter();
const auth = useAuthStore();
const catalog = ref<Catalog | null>(null);
const recent = ref<ProjectSummary[]>([]);
const idea = ref('');
const steps = [
  { icon: 'notes-o', title: '贴剧本', text: '粘贴、上传或一句话想法' },
  { icon: 'friends-o', title: '定角色', text: 'AI 生成角色和场景，可替换' },
  { icon: 'video-o', title: '出成片', text: '逐镜生成，自动拼接交付' },
];

onMounted(async () => {
  catalog.value = await api.catalog();
  if (auth.loggedIn) recent.value = (await api.listProjects()).items.slice(0, 4);
});
function start() {
  // 只把草稿带到新建页，不触发任何收费操作
  router.push({ path: '/create', query: idea.value.trim() ? { idea: idea.value.trim() } : {} });
}
</script>

<template>
  <div class="miv-page">
    <section class="hero">
      <h1>把你的剧本，<br class="br" />一键变成短片</h1>
      <p class="miv-muted">输入故事，AI 帮你写分镜、定角色、生成视频并剪成片。每一步都能查看和替换。</p>
      <div class="entry miv-card">
        <van-field v-model="idea" type="textarea" rows="3" autosize placeholder="写一句想法，或粘贴一段剧本…" :border="false" />
        <van-button type="primary" block class="miv-btn-accent" icon="play-circle-o" @click="start">开始制作</van-button>
      </div>
    </section>

    <section class="miv-section">
      <div class="miv-section-title">三步出片</div>
      <div class="steps">
        <div v-for="s in steps" :key="s.title" class="step miv-card">
          <van-icon :name="s.icon" size="26" color="var(--miv-primary)" />
          <strong>{{ s.title }}</strong>
          <span class="miv-hint">{{ s.text }}</span>
        </div>
      </div>
    </section>

    <section v-if="catalog" class="miv-section">
      <div class="miv-section-title">风格示例</div>
      <div class="miv-grid">
        <div v-for="style in catalog.styles" :key="style.id" class="style">
          <img :src="style.coverUrl" alt="" />
          <span>{{ style.name }}</span>
        </div>
      </div>
    </section>

    <section v-if="recent.length" class="miv-section">
      <div class="miv-section-title">最近作品 <router-link to="/projects" class="miv-hint">全部 ›</router-link></div>
      <div class="miv-grid"><ProjectCard v-for="p in recent" :key="p.id" :project="p" /></div>
    </section>
  </div>
</template>

<style scoped>
.hero { padding-top: var(--miv-space-4); }
h1 { font-size: 26px; line-height: 1.35; margin-bottom: var(--miv-space-2); }
.entry { margin-top: var(--miv-space-4); display: flex; flex-direction: column; gap: var(--miv-space-3); }
.entry :deep(.van-field) { padding: 0; }
.steps { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--miv-space-2); }
.step { display: flex; flex-direction: column; align-items: center; gap: var(--miv-space-1); text-align: center; padding: var(--miv-space-3) var(--miv-space-2); }
.style { position: relative; border-radius: var(--miv-radius-md); overflow: hidden; }
.style img { width: 100%; aspect-ratio: 4 / 3; object-fit: cover; }
.style span { position: absolute; left: 8px; bottom: 8px; color: var(--miv-text); background: rgba(255, 255, 255, 0.85); font-size: 12px; padding: 2px 8px; border-radius: 999px; }
@media (min-width: 1024px) {
  .hero { display: grid; grid-template-columns: 1fr 1fr; gap: var(--miv-space-6); align-items: center; padding-top: var(--miv-space-6); }
  h1 { font-size: 36px; }
  .br { display: none; }
  .entry { margin-top: 0; }
}
</style>

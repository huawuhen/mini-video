<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import type { ProjectDetail } from '@/api';

// 故事理解中（免费）：轮换具体进度文案，不放空白转圈（PRD 5.4）。
defineProps<{ project: ProjectDetail }>();
const lines = ['AI 正在细读您的故事…', '正在识别故事里的人物…', '正在构想画面…', '正在规划片段和镜头…'];
const index = ref(0);
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => { timer = setInterval(() => { index.value = (index.value + 1) % lines.length; }, 1800); });
onBeforeUnmount(() => clearInterval(timer));
</script>

<template>
  <div class="miv-card thinking">
    <van-loading size="32" color="var(--miv-primary)" />
    <strong>{{ lines[index] }}</strong>
    <p class="miv-hint">这一步免费，通常十几秒。你可以锁屏或稍后再来，完成后会保存在「我的作品」。</p>
    <div class="story">{{ project.storyText }}</div>
  </div>
</template>

<style scoped>
.thinking { display: flex; flex-direction: column; align-items: center; gap: var(--miv-space-3); text-align: center; padding: var(--miv-space-6) var(--miv-space-4); }
.story { width: 100%; text-align: left; white-space: pre-wrap; font-size: 13px; line-height: 1.7; color: var(--miv-text-2); background: var(--miv-bg); border-radius: var(--miv-radius-md); padding: var(--miv-space-3); max-height: 180px; overflow: auto; }
</style>

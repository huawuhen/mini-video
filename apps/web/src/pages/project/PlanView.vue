<script setup lang="ts">
import { ref, watch } from 'vue';
import { showToast } from 'vant';
import { api, type Plan, type ProjectDetail } from '@/api';

const props = defineProps<{ project: ProjectDetail; editable: boolean }>();
const emit = defineEmits<{ changed: [] }>();
const draft = ref<Plan | null>(null);
const editing = ref(false);
watch(() => props.project.plan, (plan) => { if (!editing.value) draft.value = plan ? (JSON.parse(JSON.stringify(plan)) as Plan) : null; }, { immediate: true });

async function save() {
  if (!draft.value) return;
  try {
    await api.updatePlan(props.project.id, { title: draft.value.title, logline: draft.value.logline, synopsis: draft.value.synopsis, scenes: draft.value.scenes });
    editing.value = false;
    showToast('剧本已保存');
    emit('changed');
  } catch (e) { showToast((e as Error).message); }
}
</script>

<template>
  <van-skeleton v-if="!draft" title :row="6" />
  <div v-else class="plan">
    <div class="miv-card">
      <div class="miv-section-title">
        <span>剧本</span>
        <van-button v-if="editable && !editing" size="small" plain type="primary" icon="edit" @click="editing = true">编辑</van-button>
      </div>
      <template v-if="!editing">
        <h2>{{ draft.title }}</h2>
        <p class="logline">{{ draft.logline }}</p>
        <p class="miv-muted">{{ draft.synopsis }}</p>
      </template>
      <template v-else>
        <van-field v-model="draft.title" label="标题" />
        <van-field v-model="draft.logline" label="一句话" />
        <van-field v-model="draft.synopsis" label="梗概" type="textarea" autosize />
      </template>
    </div>
    <div v-for="(scene, i) in draft.scenes" :key="scene.id" class="miv-card scene">
      <div class="scene-head"><van-tag type="primary" plain>场景 {{ i + 1 }}</van-tag><strong>{{ scene.title }}</strong><span class="miv-hint">{{ scene.location }}</span></div>
      <van-field v-if="editing" v-model="scene.description" type="textarea" autosize label="内容" />
      <p v-else class="miv-muted">{{ scene.description }}</p>
      <div class="dialogue">
        <div v-for="(d, j) in scene.dialogue" :key="j" class="line">
          <span class="speaker">{{ d.speaker }}</span>
          <van-field v-if="editing" v-model="d.line" :border="false" class="line-field" />
          <span v-else>{{ d.line }}</span>
        </div>
      </div>
    </div>
    <van-button v-if="editing" type="primary" block @click="save">保存修改</van-button>
  </div>
</template>

<style scoped>
.plan { display: flex; flex-direction: column; gap: var(--miv-space-3); }
h2 { font-size: 20px; margin-bottom: var(--miv-space-2); }
.logline { color: var(--miv-primary-strong); font-weight: 500; margin-bottom: var(--miv-space-2); }
.scene-head { display: flex; align-items: center; gap: var(--miv-space-2); margin-bottom: var(--miv-space-2); }
.dialogue { margin-top: var(--miv-space-3); display: flex; flex-direction: column; gap: var(--miv-space-2); }
.line { display: flex; gap: var(--miv-space-2); align-items: baseline; font-size: 14px; background: var(--miv-bg); padding: var(--miv-space-2) var(--miv-space-3); border-radius: var(--miv-radius-sm); }
.speaker { color: var(--miv-primary-strong); font-weight: 600; flex-shrink: 0; }
.line-field { padding: 0; background: transparent; }
</style>

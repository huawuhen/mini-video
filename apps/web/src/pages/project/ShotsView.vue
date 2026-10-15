<script setup lang="ts">
import { reactive, ref } from 'vue';
import { showToast } from 'vant';
import { api, type ProjectDetail, type Shot } from '@/api';
import ShotCard from '@/components/ShotCard.vue';
import { useCharge } from '@/composables/useCharge';

const props = defineProps<{ project: ProjectDetail; mode: 'review' | 'generate' | 'view' }>();
const emit = defineEmits<{ changed: [] }>();
const { confirmCharge } = useCharge();
const editingShot = ref<Shot | null>(null);
const form = reactive({ description: '', voiceover: '', durationSeconds: 10 });

function edit(shot: Shot) {
  editingShot.value = shot;
  Object.assign(form, { description: shot.description, voiceover: shot.voiceover, durationSeconds: shot.durationSeconds });
}
async function saveEdit() {
  if (!editingShot.value) return;
  try {
    await api.updateShot(props.project.id, editingShot.value.id, { ...form });
    editingShot.value = null;
    showToast('分镜已更新');
    emit('changed');
  } catch (e) { showToast((e as Error).message); }
}
async function retake(shot: Shot) {
  try {
    const quote = await confirmCharge({ kind: 'shot_take', projectId: props.project.id, shotId: shot.id }, `重拍第 ${shot.index} 镜`);
    if (!quote) return;
    await api.generateShotTake(props.project.id, shot.id, quote.quoteId, crypto.randomUUID());
    showToast('已开始重拍，新版本生成后可以切换');
    emit('changed');
  } catch (e) { showToast((e as Error).message); }
}
async function select(shot: Shot, takeId: string) {
  try {
    await api.selectShotTake(props.project.id, shot.id, takeId);
    showToast('已切换到这一版，可随时切回');
    emit('changed');
  } catch (e) { showToast((e as Error).message); }
}
</script>

<template>
  <van-skeleton v-if="!project.shots.length" title :row="6" />
  <div v-else class="shots">
    <ShotCard
      v-for="s in project.shots"
      :key="s.id"
      :shot="s"
      :ratio="project.options.ratio"
      :mode="mode"
      @edit="edit(s)"
      @retake="retake(s)"
      @select="select(s, $event)"
    />
  </div>
  <van-popup :show="!!editingShot" position="bottom" round closeable @close="editingShot = null" class="edit-popup">
    <div class="edit">
      <h3>修改第 {{ editingShot?.index }} 镜</h3>
      <van-field v-model="form.description" label="画面" type="textarea" autosize />
      <van-field v-model="form.voiceover" label="台词" type="textarea" autosize />
      <van-field label="时长（秒）"><template #input><van-stepper v-model="form.durationSeconds" :min="2" :max="30" integer /></template></van-field>
      <van-button type="primary" block @click="saveEdit">保存</van-button>
    </div>
  </van-popup>
</template>

<style scoped>
.shots { display: flex; flex-direction: column; gap: var(--miv-space-3); }
.edit { padding: var(--miv-space-5) var(--miv-space-4) var(--miv-space-4); display: flex; flex-direction: column; gap: var(--miv-space-2); max-width: 640px; margin: 0 auto; }
.edit h3 { font-size: 17px; margin-bottom: var(--miv-space-2); }
</style>

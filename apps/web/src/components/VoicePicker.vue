<script setup lang="ts">
import { computed, ref } from 'vue';
import type { Voice, VoiceCategory } from '@/api';
import VoicePlayButton from './VoicePlayButton.vue';

// 音色选择底部弹层（PRD 4.7）：分类筛选、试听、选择；disabledIds 为本作品其他角色已用的音色。
const props = defineProps<{ show: boolean; voices: Voice[]; selectedId?: string; disabledIds?: string[]; title?: string; allowNone?: boolean }>();
const emit = defineEmits<{ 'update:show': [boolean]; select: [string | null] }>();
const category = ref<VoiceCategory | 'all'>('all');
const categories = computed(() => {
  const seen = new Map<VoiceCategory, string>();
  for (const v of props.voices) seen.set(v.category, v.categoryName);
  return [...seen].map(([key, label]) => ({ key, label }));
});
const list = computed(() => props.voices.filter((v) => category.value === 'all' || v.category === category.value));
function choose(id: string | null) {
  emit('select', id);
  emit('update:show', false);
}
</script>

<template>
  <van-popup :show="show" position="bottom" round closeable safe-area-inset-bottom class="picker" @update:show="emit('update:show', $event)">
    <h3>{{ title || '选择声音' }}</h3>
    <div class="cats">
      <button type="button" :class="{ on: category === 'all' }" @click="category = 'all'">全部</button>
      <button v-for="c in categories" :key="c.key" type="button" :class="{ on: category === c.key }" @click="category = c.key">{{ c.label }}</button>
    </div>
    <div class="list">
      <div v-if="allowNone" :class="['voice', { on: !selectedId }]" role="button" tabindex="0" @click="choose(null)" @keydown.enter="choose(null)">
        <div class="info"><strong>不设置</strong><span class="miv-hint">由 AI 按角色自动推荐</span></div>
      </div>
      <div
        v-for="v in list"
        :key="v.id"
        :class="['voice', { on: v.id === selectedId, off: disabledIds?.includes(v.id) }]"
        role="button"
        :tabindex="disabledIds?.includes(v.id) ? -1 : 0"
        :aria-disabled="disabledIds?.includes(v.id)"
        @click="!disabledIds?.includes(v.id) && choose(v.id)"
        @keydown.enter="!disabledIds?.includes(v.id) && choose(v.id)"
      >
        <div class="info">
          <strong>{{ v.name }}</strong>
          <span class="miv-hint">{{ v.categoryName }} · {{ v.description }}<template v-if="disabledIds?.includes(v.id)"> · 其他角色已使用</template></span>
        </div>
        <VoicePlayButton :url="v.sampleUrl" />
        <van-icon v-if="v.id === selectedId" name="success" color="var(--miv-primary)" />
      </div>
    </div>
  </van-popup>
</template>

<style scoped>
.picker { max-height: 80vh; display: flex; flex-direction: column; padding: var(--miv-space-4); }
h3 { font-size: 17px; margin-bottom: var(--miv-space-3); }
.cats { flex: none; display: flex; gap: var(--miv-space-2); overflow-x: auto; padding-bottom: var(--miv-space-2); scrollbar-width: none; }
.cats button { flex: none; border: 1px solid var(--miv-border); background: var(--miv-surface); border-radius: 999px; padding: 4px 12px; font: inherit; font-size: 13px; color: var(--miv-text-2); cursor: pointer; }
.cats button.on { border-color: var(--miv-primary); background: var(--miv-primary-soft); color: var(--miv-primary-strong); }
.list { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: var(--miv-space-2); }
.voice { display: flex; align-items: center; gap: var(--miv-space-2); padding: var(--miv-space-3); border: 1px solid var(--miv-border); border-radius: var(--miv-radius-md); cursor: pointer; }
.voice.on { border-color: var(--miv-primary); background: var(--miv-primary-soft); }
.voice.off { opacity: 0.5; cursor: not-allowed; }
.info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
/* PC：居中窄弹层；不改 transform，避免影响 Vant 的出入场动画 */
@media (min-width: 1024px) { .picker { width: 560px; left: 0; right: 0; margin: 0 auto; } }
</style>

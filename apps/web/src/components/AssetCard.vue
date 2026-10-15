<script setup lang="ts">
import { computed } from 'vue';
import type { Asset } from '@/api';
import MediaPlaceholder from './MediaPlaceholder.vue';

const props = defineProps<{ asset: Asset; editable: boolean }>();
const emit = defineEmits<{ regenerate: []; select: [versionId: string] }>();
const kindLabel = { character: '角色', scene: '场景', prop: '道具' } as const;
const selected = computed(() => props.asset.versions.find((v) => v.id === props.asset.selectedVersionId));
const running = computed(() => props.asset.versions.some((v) => v.status === 'running' || v.status === 'pending'));
</script>

<template>
  <div class="asset miv-card">
    <MediaPlaceholder :src="selected?.imageUrl" ratio="3:4" />
    <div class="head">
      <van-tag type="primary" plain>{{ kindLabel[asset.kind] }}</van-tag>
      <strong>{{ asset.name }}</strong>
      <van-icon v-if="asset.locked" name="lock" class="lock" />
    </div>
    <p class="miv-hint desc">{{ asset.description }}</p>
    <div v-if="asset.versions.length > 1 || running" class="versions">
      <button
        v-for="v in asset.versions"
        :key="v.id"
        type="button"
        :class="['thumb', { on: v.id === asset.selectedVersionId }]"
        :disabled="v.status !== 'succeeded' || !editable"
        @click="emit('select', v.id)"
      >
        <img v-if="v.imageUrl" :src="v.imageUrl" alt="" />
        <van-loading v-else size="16" />
      </button>
    </div>
    <van-button v-if="editable" size="small" block plain type="primary" :loading="running" @click="emit('regenerate')">
      重新生成一张
    </van-button>
  </div>
</template>

<style scoped>
.asset { padding: var(--miv-space-3); display: flex; flex-direction: column; gap: var(--miv-space-2); }
.head { display: flex; align-items: center; gap: var(--miv-space-2); margin-top: var(--miv-space-1); }
.lock { color: var(--miv-text-3); margin-left: auto; }
.desc { min-height: 32px; }
.versions { display: flex; gap: var(--miv-space-2); overflow-x: auto; }
.thumb { width: 44px; height: 44px; flex-shrink: 0; border-radius: var(--miv-radius-sm); border: 2px solid transparent; padding: 0; overflow: hidden; background: var(--miv-primary-soft); display: flex; align-items: center; justify-content: center; cursor: pointer; }
.thumb.on { border-color: var(--miv-primary); }
.thumb img { width: 100%; height: 100%; object-fit: cover; }
</style>

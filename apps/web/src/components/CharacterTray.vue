<script setup lang="ts">
import type { Character } from '@/api';

// 首页「我的数字资产库」托盘：横滑头像、多选；末尾「+ 新建数字人」（PRD 5.1）。
const props = defineProps<{ characters: Character[]; modelValue: string[]; styleId?: string }>();
const emit = defineEmits<{ 'update:modelValue': [string[]]; add: [] }>();

function toggle(id: string) {
  const set = new Set(props.modelValue);
  if (set.has(id)) set.delete(id); else set.add(id);
  emit('update:modelValue', [...set]);
}
</script>

<template>
  <div class="tray" role="group" aria-label="我的数字资产库">
    <button
      v-for="c in characters"
      :key="c.id"
      type="button"
      :class="['item', { on: modelValue.includes(c.id) }]"
      :aria-pressed="modelValue.includes(c.id)"
      @click="toggle(c.id)"
    >
      <span class="avatar">
        <img v-if="c.avatarUrl" :src="c.avatarUrl" alt="" />
        <van-icon v-else name="user-o" size="22" />
        <van-icon v-if="modelValue.includes(c.id)" name="success" class="check" />
      </span>
      <span class="name">{{ c.name }}</span>
      <span v-if="styleId && !c.styleIds.includes(styleId)" class="hint">需生成形象</span>
    </button>
    <button type="button" class="item add" @click="emit('add')">
      <span class="avatar"><van-icon name="plus" size="22" /></span>
      <span class="name">新建数字人</span>
    </button>
  </div>
</template>

<style scoped>
.tray { display: flex; gap: var(--miv-space-3); overflow-x: auto; padding: var(--miv-space-1) 2px var(--miv-space-2); scrollbar-width: none; }
.tray::-webkit-scrollbar { display: none; }
.item { flex: none; width: 64px; display: flex; flex-direction: column; align-items: center; gap: var(--miv-space-1); background: none; border: 0; padding: 0; cursor: pointer; font: inherit; color: var(--miv-text); }
.avatar { position: relative; width: 56px; height: 56px; border-radius: 50%; overflow: hidden; display: flex; align-items: center; justify-content: center; background: var(--miv-primary-soft); color: var(--miv-primary); border: 2px solid transparent; }
.avatar img { width: 100%; height: 100%; object-fit: cover; }
.on .avatar { border-color: var(--miv-primary); }
.check { position: absolute; right: 0; bottom: 0; background: var(--miv-primary); color: var(--miv-on-primary); border-radius: 50%; font-size: 12px; padding: 2px; }
.add .avatar { background: var(--miv-bg); border: 1px dashed var(--miv-border); color: var(--miv-text-2); }
.name { font-size: 12px; max-width: 64px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hint { font-size: 10px; color: var(--miv-warning); }
</style>

<script setup lang="ts">
import { useRoute } from 'vue-router';
import { useBreakpoint } from '@/composables/useBreakpoint';
const { isDesktop } = useBreakpoint();
const route = useRoute();
</script>

<template>
  <!-- 手机：固定在底部（避开 Tabbar）；PC：内容区底部的普通操作区 -->
  <div :class="['action-bar', isDesktop ? 'inline' : 'sticky', { 'no-tabbar': route.meta.hideTabbar }]">
    <div class="info"><slot name="info" /></div>
    <div class="buttons"><slot /></div>
  </div>
  <div v-if="!isDesktop" class="spacer" />
</template>

<style scoped>
.action-bar { display: flex; align-items: center; gap: var(--miv-space-3); background: var(--miv-surface); }
.sticky { position: fixed; left: 0; right: 0; bottom: calc(var(--miv-tabbar-height) + env(safe-area-inset-bottom)); padding: var(--miv-space-3) var(--miv-space-4); border-top: 1px solid var(--miv-border); z-index: 20; }
.sticky.no-tabbar { bottom: 0; padding-bottom: calc(var(--miv-space-3) + env(safe-area-inset-bottom)); }
.inline { margin-top: var(--miv-space-5); padding: var(--miv-space-4); border-radius: var(--miv-radius-lg); box-shadow: var(--miv-shadow); }
.info { flex: 1; min-width: 0; }
.buttons { display: flex; gap: var(--miv-space-2); }
.spacer { height: 76px; }
</style>

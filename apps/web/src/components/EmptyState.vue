<script setup lang="ts">
defineProps<{ title: string; description?: string }>();
</script>

<template>
  <div class="empty">
    <van-empty :description="title" image-size="96">
      <p v-if="description" class="miv-hint">{{ description }}</p>
      <div class="actions"><slot /></div>
    </van-empty>
  </div>
</template>

<style scoped>
.empty { padding: var(--miv-space-6) 0; }
.actions { margin-top: var(--miv-space-3); }
</style>

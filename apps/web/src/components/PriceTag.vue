<script setup lang="ts">
import { formatFen } from '@/utils/money';
defineProps<{ fen: number; size?: 'sm' | 'lg' }>();
</script>

<template>
  <span class="price" :class="size"><small>¥</small>{{ formatFen(fen) }}</span>
</template>

<style scoped>
.price { color: var(--miv-accent); font-weight: 600; font-variant-numeric: tabular-nums; }
.price small { font-size: 0.75em; margin-right: 1px; }
.price.lg { font-size: 26px; }
.price.sm { font-size: 13px; }
</style>

<script setup lang="ts">
import { computed } from 'vue';
import { daysLeft, formatDate } from '@/utils/time';

// 保存期提示条（PRD 5.5 / 8.1）：常驻显示到期日；临近到期变为醒目样式。
const props = defineProps<{ expiresAt?: string; remindDays: number; retentionDays: number }>();
const left = computed(() => (props.expiresAt ? daysLeft(props.expiresAt) : null));
const urgent = computed(() => left.value !== null && left.value <= props.remindDays);
</script>

<template>
  <div v-if="expiresAt" :class="['banner', { urgent }]" role="status">
    <van-icon :name="urgent ? 'warning-o' : 'clock-o'" />
    <span v-if="urgent">还有 {{ left }} 天过期（{{ formatDate(expiresAt) }}），请尽快保存到手机</span>
    <span v-else>作品将保存 {{ Math.round(retentionDays / 30) }} 个月，至 {{ formatDate(expiresAt) }}，请及时保存到手机</span>
  </div>
</template>

<style scoped>
.banner { display: flex; align-items: flex-start; gap: var(--miv-space-2); padding: var(--miv-space-2) var(--miv-space-3); border-radius: var(--miv-radius-md); background: var(--miv-primary-soft); color: var(--miv-primary-strong); font-size: 13px; line-height: 1.5; }
.banner .van-icon { margin-top: 3px; }
.urgent { background: var(--miv-warning-soft); color: var(--miv-warning); }
</style>

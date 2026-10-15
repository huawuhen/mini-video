<script setup lang="ts">
import { computed } from 'vue';
import type { ProjectStatus } from '@/api';
import { projectStatusMeta } from '@/utils/status';

const props = defineProps<{ status: ProjectStatus }>();
const meta = computed(() => projectStatusMeta[props.status]);
</script>

<template>
  <van-tag :type="meta.tone" plain round>{{ meta.label }}</van-tag>
</template>

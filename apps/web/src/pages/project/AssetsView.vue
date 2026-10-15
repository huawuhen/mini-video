<script setup lang="ts">
import { showToast } from 'vant';
import { api, type Asset, type ProjectDetail } from '@/api';
import AssetCard from '@/components/AssetCard.vue';
import { useCharge } from '@/composables/useCharge';

const props = defineProps<{ project: ProjectDetail; editable: boolean }>();
const emit = defineEmits<{ changed: [] }>();
const { confirmCharge } = useCharge();

async function regenerate(asset: Asset) {
  try {
    const quote = await confirmCharge({ kind: 'asset_version', projectId: props.project.id, assetId: asset.id }, `重新生成「${asset.name}」`);
    if (!quote) return;
    await api.generateAssetVersion(props.project.id, asset.id, quote.quoteId, crypto.randomUUID());
    showToast('已开始生成，完成后可在缩略图中切换');
    emit('changed');
  } catch (e) { showToast((e as Error).message); }
}
async function select(asset: Asset, versionId: string) {
  try {
    await api.selectAssetVersion(props.project.id, asset.id, versionId);
    showToast('已切换到这个版本，可随时切回');
    emit('changed');
  } catch (e) { showToast((e as Error).message); }
}
</script>

<template>
  <van-skeleton v-if="!project.assets.length" title :row="6" />
  <div v-else>
    <p class="miv-hint tip">确认后角色和场景会被锁定，后续每个镜头都会参照它们，保证人物前后一致。</p>
    <div class="miv-grid">
      <AssetCard v-for="a in project.assets" :key="a.id" :asset="a" :editable="editable" @regenerate="regenerate(a)" @select="select(a, $event)" />
    </div>
  </div>
</template>

<style scoped>
.tip { margin-bottom: var(--miv-space-3); }
</style>

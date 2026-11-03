<script setup lang="ts">
// 照片使用说明弹层（M3-LEGAL-01）：正文来自 docs/legal/photo-consent.md（唯一来源，不手抄）。
// 「不同意」关闭不上传；「同意并上传」调 POST /me/consents 后继续。由 usePhotoConsent 驱动。
import { computed, ref } from 'vue';
import { showFailToast } from 'vant';
import { api } from '@/api';
import { photoConsentText, renderLegalMarkdown } from '@/utils/legal';
import { useAuthStore } from '@/stores/auth';

const auth = useAuthStore();

const visible = defineModel<boolean>({ required: true });
const deciding = ref(false);
const html = computed(() => renderLegalMarkdown(photoConsentText));
const emit = defineEmits<{ decided: [agreed: boolean] }>();

async function agree() {
  if (deciding.value) return;
  deciding.value = true;
  try {
    // 提交版本以服务端 consents.current 为准（复审必改④：前端不再自带版本常量）
    const version = auth.user?.consents?.current?.photo;
    if (!version) throw new Error('无法获取当前协议版本，请稍后再试');
    await api.photoConsent(version);
    visible.value = false;
    emit('decided', true);
  } catch (e) {
    showFailToast((e as Error).message);
  } finally {
    deciding.value = false;
  }
}
function decline() {
  visible.value = false;
  emit('decided', false);
}
</script>

<template>
  <van-popup v-model:show="visible" position="bottom" round class="sheet" :style="{ maxHeight: '85vh' }">
    <div class="head">
      <strong>照片使用说明与同意</strong>
      <button type="button" class="close" aria-label="关闭" @click="decline">×</button>
    </div>
    <div class="scroll">
      <article class="doc" v-html="html" />
      <p class="miv-hint">不同意不会上传任何照片；同意仅针对上方说明所列用途，可随时删除照片。<router-link class="legal-link" to="/legal/privacy" target="_blank">《隐私政策》</router-link></p>
    </div>
    <div class="actions">
      <van-button block plain type="default" @click="decline">不同意</van-button>
      <van-button block type="primary" class="miv-btn-accent" :loading="deciding" @click="agree">同意并上传</van-button>
    </div>
  </van-popup>
</template>

<style scoped>
.sheet { display: flex; flex-direction: column; background: var(--miv-surface); }
.legal-link { color: var(--miv-primary); }
.head { display: flex; align-items: center; justify-content: space-between; padding: var(--miv-space-3) var(--miv-space-4) 0; }
.head strong { font-size: 16px; }
.close { border: 0; background: transparent; font-size: 22px; line-height: 1; color: var(--miv-text-3); cursor: pointer; padding: 4px 8px; }
.scroll { overflow-y: auto; padding: var(--miv-space-3) var(--miv-space-4); }
.doc { font-size: 14px; line-height: 1.7; color: var(--miv-text); }
.doc :deep(h2) { font-size: 16px; margin: 1.2em 0 0.5em; }
.doc :deep(h3), .doc :deep(h4), .doc :deep(h5) { font-size: 14.5px; margin: 1em 0 0.4em; }
.doc :deep(p) { margin: 0.5em 0; }
.doc :deep(blockquote) { margin: 0.6em 0; padding: 0.5em 0.8em; background: var(--miv-primary-soft);
  border-left: 3px solid var(--miv-primary); font-size: 12.5px; color: var(--miv-text-2); }
.doc :deep(ul), .doc :deep(ol) { margin: 0.5em 0; padding-left: 1.3em; }
.doc :deep(ol) { list-style: decimal; }  /* M3-LEGAL-01 必改⑤：保留条款序号 */
.doc :deep(li) { margin: 0.25em 0; }
.doc :deep(table) { display: block; max-width: 100%; overflow-x: auto; border-collapse: collapse;
  margin: 0.6em 0; font-size: 12.5px; white-space: nowrap; }
.doc :deep(th), .doc :deep(td) { border: 1px solid var(--miv-border); padding: 4px 8px; text-align: left; }
.doc :deep(th) { background: var(--miv-bg); }
.actions { display: flex; gap: var(--miv-space-2); padding: var(--miv-space-3) var(--miv-space-4) calc(var(--miv-space-3) + env(safe-area-inset-bottom)); }
.actions > * { flex: 1; }
</style>

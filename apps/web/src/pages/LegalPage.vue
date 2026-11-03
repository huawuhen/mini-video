<script setup lang="ts">
// 协议页（M3-LEGAL-01）：正文来自 docs/legal/*.md（构建时 ?raw 导入 + 轻量渲染，不手抄改写）。
// 无需登录；移动端 375 阅读友好（正文限宽、行高 1.7、表格横向滚动），PC 居中限宽。
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { renderLegalMarkdown, privacyText, termsText } from '@/utils/legal';

const route = useRoute();
const router = useRouter();
const doc = computed(() => (route.path === '/legal/privacy' ? privacyText : termsText));
const title = computed(() => (route.path === '/legal/privacy' ? '隐私政策' : '用户协议'));
const html = computed(() => renderLegalMarkdown(doc.value));
</script>

<template>
  <div class="legal-page">
    <header class="bar">
      <van-nav-bar :title="title" left-arrow @click-left="router.back()" />
    </header>
    <article class="doc miv-card" v-html="html" />
    <p class="miv-hint foot">对协议内容有疑问，请联系客服 help@redith.cn</p>
  </div>
</template>

<style scoped>
.legal-page { min-height: 100vh; background: var(--miv-bg); }
header.bar { position: sticky; top: 0; z-index: 5; }
/* PC 阅读限宽 760 并居中（AGENTS §6 双端走查在 1280 实测 1265 超宽，修复） */
.legal-page { max-width: 760px; margin: 0 auto; }
.doc { margin: var(--miv-space-3); padding: var(--miv-space-4); font-size: 15px; line-height: 1.75;
  color: var(--miv-text); overflow-wrap: break-word; }
.doc :deep(h2) { font-size: 19px; margin: 1.4em 0 0.6em; }
.doc :deep(h3) { font-size: 17px; margin: 1.2em 0 0.5em; }
.doc :deep(h4), .doc :deep(h5) { font-size: 15.5px; margin: 1em 0 0.4em; }
.doc :deep(p) { margin: 0.6em 0; }
.doc :deep(strong) { color: var(--miv-text); }
.doc :deep(blockquote) { margin: 0.8em 0; padding: 0.6em 0.9em; background: var(--miv-primary-soft);
  border-left: 3px solid var(--miv-primary); border-radius: 0 var(--miv-radius-sm) var(--miv-radius-sm) 0;
  font-size: 13.5px; color: var(--miv-text-2); }
.doc :deep(ul), .doc :deep(ol) { margin: 0.6em 0; padding-left: 1.4em; }
.doc :deep(li) { margin: 0.3em 0; }
/* 表格横向滚动（375px 下宽表不挤爆版式） */
.doc :deep(table) { display: block; max-width: 100%; overflow-x: auto; border-collapse: collapse;
  margin: 0.8em 0; font-size: 13.5px; white-space: nowrap; }
.doc :deep(th), .doc :deep(td) { border: 1px solid var(--miv-border); padding: 6px 10px; text-align: left; }
.doc :deep(th) { background: var(--miv-bg); font-weight: 600; }
.foot { text-align: center; padding: 0 var(--miv-space-3) var(--miv-space-4); }
@media (min-width: 768px) {
  .doc { max-width: 760px; margin: var(--miv-space-4) auto; padding: var(--miv-space-5); }
}
</style>

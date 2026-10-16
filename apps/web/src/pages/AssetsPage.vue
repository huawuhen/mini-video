<script setup lang="ts">
// 我的数字资产库（PRD 5.2）：「数字人」= 用户自己的资产；「声音」= 平台音频素材库。
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, type Character, type VoiceCategory } from '@/api';
import VoicePlayButton from '@/components/VoicePlayButton.vue';
import { useCatalogStore } from '@/stores/catalog';
import { formatDate } from '@/utils/time';

const route = useRoute();
const router = useRouter();
const catalogStore = useCatalogStore();
const tab = ref(route.query.tab === 'voices' ? 'voices' : 'people');
const characters = ref<Character[] | null>(null);
const category = ref<VoiceCategory | 'all'>('all');
const categories = computed(() => [...new Map(catalogStore.voices.map((v) => [v.category, v.categoryName]))].map(([key, label]) => ({ key, label })));
const voices = computed(() => catalogStore.voices.filter((v) => category.value === 'all' || v.category === category.value));

onMounted(async () => {
  await catalogStore.load();
  characters.value = (await api.listCharacters()).items;
});
function onTab(name: string) { router.replace({ query: name === 'voices' ? { tab: 'voices' } : {} }); }
</script>

<template>
  <div class="miv-page assets">
    <h1 class="page-title">我的数字资产库</h1>
    <van-tabs v-model:active="tab" shrink background="transparent" @change="onTab">
      <van-tab title="数字人" name="people">
        <van-skeleton v-if="!characters" :row="4" class="pad" />
        <div v-else class="miv-grid grid">
          <router-link to="/assets/new" class="cell add miv-card">
            <van-icon name="photograph" size="28" />
            <strong>新建数字人</strong>
            <span class="miv-hint">上传照片或写一段描述</span>
          </router-link>
          <router-link v-for="c in characters" :key="c.id" :to="`/assets/${c.id}`" class="cell miv-card">
            <div class="avatar">
              <img v-if="c.avatarUrl" :src="c.avatarUrl" alt="" />
              <van-icon v-else name="user-o" size="32" />
            </div>
            <strong>{{ c.name }}</strong>
            <span class="miv-hint">已参与 {{ c.worksCount }} 部作品 · {{ formatDate(c.createdAt) }}</span>
            <div class="badges">
              <span v-for="s in c.styleIds" :key="s" class="badge">{{ catalogStore.styleName(s) }}</span>
              <span v-if="!c.styleIds.length" class="badge muted">还没有形象</span>
            </div>
          </router-link>
        </div>
      </van-tab>
      <van-tab title="声音" name="voices">
        <p class="miv-hint pad">平台提供的常用音色。多片段作品中同一角色会一直使用同一个声音；不选时 AI 会按角色自动配。</p>
        <div class="cats">
          <button type="button" :class="{ on: category === 'all' }" @click="category = 'all'">全部</button>
          <button v-for="c in categories" :key="c.key" type="button" :class="{ on: category === c.key }" @click="category = c.key">{{ c.label }}</button>
        </div>
        <div class="voices">
          <div v-for="v in voices" :key="v.id" class="voice miv-card">
            <div class="info"><strong>{{ v.name }}</strong><span class="miv-hint">{{ v.categoryName }} · {{ v.description }}</span></div>
            <VoicePlayButton :url="v.sampleUrl" />
          </div>
        </div>
      </van-tab>
    </van-tabs>
  </div>
</template>

<style scoped>
.page-title { font-size: 20px; margin-bottom: var(--miv-space-2); }
.pad { padding: var(--miv-space-3) 0; }
.grid { margin-top: var(--miv-space-3); }
.cell { display: flex; flex-direction: column; align-items: center; gap: var(--miv-space-1); text-align: center; color: inherit; padding: var(--miv-space-4) var(--miv-space-3); }
.add { border: 1px dashed var(--miv-border); box-shadow: none; color: var(--miv-primary-strong); justify-content: center; }
.avatar { width: 72px; height: 72px; border-radius: 50%; overflow: hidden; background: var(--miv-primary-soft); color: var(--miv-primary); display: flex; align-items: center; justify-content: center; margin-bottom: var(--miv-space-1); }
.avatar img { width: 100%; height: 100%; object-fit: cover; }
.badges { display: flex; flex-wrap: wrap; justify-content: center; gap: 4px; margin-top: var(--miv-space-1); }
.badge { font-size: 11px; padding: 1px 6px; border-radius: 999px; background: var(--miv-primary-soft); color: var(--miv-primary-strong); }
.badge.muted { background: var(--miv-bg); color: var(--miv-text-3); }
.cats { display: flex; gap: var(--miv-space-2); overflow-x: auto; padding-bottom: var(--miv-space-3); scrollbar-width: none; }
.cats button { flex: none; border: 1px solid var(--miv-border); background: var(--miv-surface); border-radius: 999px; padding: 4px 12px; font: inherit; font-size: 13px; color: var(--miv-text-2); cursor: pointer; }
.cats button.on { border-color: var(--miv-primary); background: var(--miv-primary-soft); color: var(--miv-primary-strong); }
.voices { display: grid; gap: var(--miv-space-2); grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); }
.voice { display: flex; align-items: center; gap: var(--miv-space-2); padding: var(--miv-space-3); }
.info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
</style>

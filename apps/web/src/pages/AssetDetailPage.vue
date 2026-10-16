<script setup lang="ts">
// 数字人详情：参考照片、各风格形象与版本（永不覆盖，只新增 + 切换）、默认声音、重命名、删除。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { showConfirmDialog, showToast } from 'vant';
import { api, type CharacterDetail } from '@/api';
import VoicePicker from '@/components/VoicePicker.vue';
import VoicePlayButton from '@/components/VoicePlayButton.vue';
import { useCharge } from '@/composables/useCharge';
import { useCatalogStore } from '@/stores/catalog';

const route = useRoute();
const router = useRouter();
const catalogStore = useCatalogStore();
const { confirmCharge } = useCharge();
const id = computed(() => String(route.params.id));
const character = ref<CharacterDetail | null>(null);
const error = ref('');
const showVoices = ref(false);
const busy = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;

const voice = computed(() => catalogStore.voiceById(character.value?.defaultVoiceId));
const generating = computed(() => character.value?.looks.some((l) => l.versions.some((v) => v.status === 'running' || v.status === 'pending')));
const missingStyles = computed(() => catalogStore.catalog?.styles.filter((s) => !character.value?.looks.some((l) => l.styleId === s.id && l.versions.length)) ?? []);

async function load() {
  clearTimeout(timer);
  try { character.value = await api.getCharacter(id.value); error.value = ''; } catch (e) { error.value = (e as Error).message; }
  if (generating.value) timer = setTimeout(load, 2000);
}
onMounted(async () => { await catalogStore.load(); await load(); });
onBeforeUnmount(() => clearTimeout(timer));

async function run(action: () => Promise<unknown>, done?: string) {
  if (busy.value) return;
  busy.value = true;
  try { await action(); if (done) showToast(done); await load(); } catch (e) { showToast((e as Error).message); } finally { busy.value = false; }
}
async function generate(styleId: string) {
  const c = character.value;
  if (!c) return;
  const quote = await confirmCharge({ kind: 'look_regenerate', characterId: c.id, styleId }, `生成「${catalogStore.styleName(styleId)}」形象`, '确认并生成');
  if (quote) run(() => api.generateLook(c.id, styleId, quote.quoteId, crypto.randomUUID()), '已开始生成，旧版本会保留');
}
const select = (styleId: string, versionId: string) => run(() => api.selectLook(id.value, styleId, versionId), '已切换到这个版本，可随时切回');
const setVoice = (voiceId: string | null) => run(() => api.updateCharacter(id.value, { defaultVoiceId: voiceId }), '默认声音已更新');
async function rename() {
  const name = window.prompt('新的昵称', character.value?.name)?.trim();
  if (name) run(() => api.updateCharacter(id.value, { name }), '已重命名');
}
async function remove() {
  const c = character.value;
  if (!c) return;
  try { await showConfirmDialog({ title: `删除「${c.name}」？`, message: `已参与 ${c.worksCount} 部作品，历史作品不受影响。` }); } catch { return; }
  await run(() => api.deleteCharacter(c.id));
  router.replace('/assets');
}
</script>

<template>
  <van-nav-bar :title="character?.name || '数字人'" left-arrow @click-left="router.push('/assets')" class="nav" />
  <div class="miv-page detail">
    <van-empty v-if="error && !character" :description="error" />
    <van-skeleton v-else-if="!character" :row="6" />
    <template v-else>
      <section class="miv-card head">
        <div class="avatar"><img v-if="character.avatarUrl" :src="character.avatarUrl" alt="" /><van-icon v-else name="user-o" size="32" /></div>
        <div class="info">
          <h1>{{ character.name }}</h1>
          <p class="miv-hint">已参与 {{ character.worksCount }} 部作品<template v-if="character.tags.length"> · {{ character.tags.join('、') }}</template></p>
          <p v-if="character.description" class="miv-muted">{{ character.description }}</p>
        </div>
        <van-button size="small" plain @click="rename">重命名</van-button>
      </section>

      <section class="miv-card">
        <div class="miv-section-title">参考照片</div>
        <div v-if="character.photos.length" class="photos"><img v-for="p in character.photos" :key="p.uploadId" :src="p.url" alt="" /></div>
        <p v-else class="miv-hint">没有照片，形象按文字描述生成</p>
      </section>

      <section class="miv-card">
        <div class="miv-section-title">形象 <span class="miv-hint">重新生成会新增版本，旧版本保留</span></div>
        <div v-for="look in character.looks.filter((l) => l.versions.length)" :key="look.styleId" class="look">
          <div class="look-head">
            <strong>{{ catalogStore.styleName(look.styleId) }}</strong>
            <van-button size="mini" plain type="primary" :disabled="busy" @click="generate(look.styleId)">重新生成</van-button>
          </div>
          <div class="versions">
            <button
              v-for="(v, i) in look.versions"
              :key="v.id"
              type="button"
              :class="['version', { on: v.id === look.selectedVersionId }]"
              :disabled="v.status !== 'succeeded' || busy"
              @click="select(look.styleId, v.id)"
            >
              <img v-if="v.imageUrl" :src="v.imageUrl" alt="" />
              <van-loading v-else-if="v.status === 'running' || v.status === 'pending'" size="20" />
              <van-icon v-else name="warning-o" />
              <span>第 {{ i + 1 }} 版<template v-if="v.id === look.selectedVersionId"> · 使用中</template></span>
            </button>
          </div>
        </div>
        <div v-if="missingStyles.length" class="more">
          <span class="miv-hint">生成其他风格：</span>
          <van-button v-for="s in missingStyles" :key="s.id" size="mini" plain :disabled="busy" @click="generate(s.id)">{{ s.name }}</van-button>
        </div>
      </section>

      <section class="miv-card">
        <van-cell title="默认声音" is-link :value="voice?.name || '不设置（AI 自动推荐）'" @click="showVoices = true" />
        <div v-if="voice" class="voice-play"><VoicePlayButton :url="voice.sampleUrl" /></div>
      </section>

      <van-button block plain type="danger" class="remove" @click="remove">删除这个数字人</van-button>
    </template>
  </div>
  <VoicePicker v-model:show="showVoices" :voices="catalogStore.voices" :selected-id="character?.defaultVoiceId" allow-none title="选择默认声音" @select="setVoice" />
</template>

<style scoped>
.nav { position: sticky; top: 0; z-index: 10; }
.detail { display: flex; flex-direction: column; gap: var(--miv-space-3); max-width: 760px; }
.head { display: flex; gap: var(--miv-space-3); align-items: flex-start; }
.avatar { flex: none; width: 64px; height: 64px; border-radius: 50%; overflow: hidden; background: var(--miv-primary-soft); color: var(--miv-primary); display: flex; align-items: center; justify-content: center; }
.avatar img { width: 100%; height: 100%; object-fit: cover; }
.info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
h1 { font-size: 20px; }
.photos { display: flex; gap: var(--miv-space-2); flex-wrap: wrap; }
.photos img { width: 72px; height: 72px; object-fit: cover; border-radius: var(--miv-radius-sm); }
.look { padding: var(--miv-space-2) 0; border-bottom: 1px solid var(--miv-border); }
.look:last-of-type { border-bottom: 0; }
.look-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: var(--miv-space-2); }
.versions { display: flex; gap: var(--miv-space-2); overflow-x: auto; }
.version { flex: none; width: 88px; display: flex; flex-direction: column; align-items: center; gap: 4px; border: 2px solid transparent; border-radius: var(--miv-radius-md); padding: 2px; background: none; cursor: pointer; font: inherit; font-size: 11px; color: var(--miv-text-2); }
.version img, .version .van-loading, .version .van-icon { width: 80px; height: 80px; border-radius: var(--miv-radius-sm); object-fit: cover; display: flex; align-items: center; justify-content: center; background: var(--miv-primary-soft); }
.version.on { border-color: var(--miv-primary); color: var(--miv-primary-strong); }
.more { display: flex; flex-wrap: wrap; align-items: center; gap: var(--miv-space-2); margin-top: var(--miv-space-3); }
.voice-play { padding: 0 var(--miv-space-4); }
.remove { margin: var(--miv-space-3) 0 var(--miv-space-5); }
@media (min-width: 1024px) { .nav { display: none; } }
</style>

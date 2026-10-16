<script setup lang="ts">
// 新建数字人（PRD 4.1）：昵称、标签、0~5 张照片或文字描述、默认声音；可选立即生成一个风格的形象（收费，先报价）。
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { showToast, type UploaderFileListItem } from 'vant';
import { api } from '@/api';
import StylePicker from '@/components/StylePicker.vue';
import VoicePicker from '@/components/VoicePicker.vue';
import { useCharge } from '@/composables/useCharge';
import { useCatalogStore } from '@/stores/catalog';

const router = useRouter();
const catalogStore = useCatalogStore();
const { confirmCharge } = useCharge();
const form = reactive({ name: '', tags: '', description: '', defaultVoiceId: undefined as string | undefined, styleId: '' });
const photos = ref<UploaderFileListItem[]>([]);
const uploadIds = new Map<UploaderFileListItem, string>();
const showVoices = ref(false);
const saving = ref(false);
const maxPhotos = computed(() => catalogStore.catalog?.limits.maxCharacterPhotos ?? 5);
const voice = computed(() => catalogStore.voiceById(form.defaultVoiceId));
const valid = computed(() => form.name.trim() && (photos.value.length > 0 || form.description.trim()));

onMounted(async () => { const c = await catalogStore.load(); form.styleId = c.styles[0]?.id || ''; });

async function afterRead(item: UploaderFileListItem | UploaderFileListItem[]) {
  for (const it of Array.isArray(item) ? item : [item]) {
    if (!it.file) continue;
    it.status = 'uploading';
    try {
      uploadIds.set(it, (await api.uploadImage(it.file)).uploadId);
      it.status = 'done';
    } catch (e) {
      it.status = 'failed';
      it.message = '上传失败';
      showToast((e as Error).message);
    }
  }
}

async function save(withLook: boolean) {
  if (!valid.value || saving.value) return;
  if (photos.value.some((p) => p.status === 'uploading')) { showToast('照片还在上传，请稍等'); return; }
  saving.value = true;
  try {
    const character = await api.createCharacter({
      name: form.name.trim(),
      tags: form.tags.split(/[,，\s]+/).filter(Boolean),
      description: form.description.trim() || undefined,
      photoUploadIds: photos.value.map((p) => uploadIds.get(p)).filter((id): id is string => !!id),
      defaultVoiceId: form.defaultVoiceId,
    });
    if (withLook && form.styleId) {
      const quote = await confirmCharge({ kind: 'look_regenerate', characterId: character.id, styleId: form.styleId }, '生成数字人形象', '确认并生成');
      if (quote) await api.generateLook(character.id, form.styleId, quote.quoteId, crypto.randomUUID());
    }
    router.replace(`/assets/${character.id}`);
  } catch (e) { showToast((e as Error).message); } finally { saving.value = false; }
}
</script>

<template>
  <van-nav-bar title="新建数字人" left-arrow @click-left="router.back()" class="nav" />
  <div class="miv-page new">
    <section class="miv-card">
      <van-field v-model="form.name" label="昵称" placeholder="如：宝宝、妈妈、爷爷" maxlength="20" required />
      <van-field v-model="form.tags" label="标签" placeholder="可选，用逗号分隔" maxlength="60" />
    </section>

    <section class="miv-card">
      <div class="miv-section-title">照片 <span class="miv-hint">1~{{ maxPhotos }} 张清晰正脸照，效果更像</span></div>
      <van-uploader v-model="photos" :max-count="maxPhotos" multiple accept="image/jpeg,image/png,image/webp" :after-read="afterRead" />
      <van-field v-model="form.description" type="textarea" rows="2" autosize label="外貌描述" :placeholder="photos.length ? '可选，补充发型、穿着等' : '没有照片时必填，如：5 岁小女孩，短发，爱穿黄色裙子'" maxlength="200" />
      <p class="miv-hint">照片只用于生成你自己的数字人，永久保存在你的账号下，仅你本人可见。</p>
    </section>

    <section class="miv-card">
      <van-cell title="默认声音" is-link :value="voice?.name || '不设置（AI 自动推荐）'" @click="showVoices = true" />
      <p class="miv-hint">设置后，以后的作品会自动使用这个声音，确认角色时仍可更换。</p>
    </section>

    <section v-if="catalogStore.catalog" class="miv-card">
      <div class="miv-section-title">生成形象的风格</div>
      <StylePicker v-model="form.styleId" :styles="catalogStore.catalog.styles" />
    </section>

    <div class="actions">
      <van-button type="primary" class="miv-btn-accent" block :disabled="!valid" :loading="saving" @click="save(true)">保存并生成形象</van-button>
      <van-button block plain :disabled="!valid || saving" @click="save(false)">只保存，稍后生成</van-button>
    </div>
  </div>
  <VoicePicker v-model:show="showVoices" :voices="catalogStore.voices" :selected-id="form.defaultVoiceId" allow-none title="选择默认声音" @select="form.defaultVoiceId = $event ?? undefined" />
</template>

<style scoped>
.nav { position: sticky; top: 0; z-index: 10; }
.new { display: flex; flex-direction: column; gap: var(--miv-space-3); max-width: 720px; }
.actions { display: flex; flex-direction: column; gap: var(--miv-space-2); padding-bottom: var(--miv-space-5); }
@media (min-width: 1024px) { .nav { display: none; } }
</style>

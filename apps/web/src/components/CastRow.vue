<script setup lang="ts">
import { computed } from 'vue';
import type { CastMember, Voice } from '@/api';
import { ageLabel, genderLabel } from '@/utils/status';
import VoicePlayButton from './VoicePlayButton.vue';

// 确认点 A / B 的角色行（PRD 5.3）。mode=story：显示匹配结果；mode=cast：形象版本 + 声音。
const props = defineProps<{ member: CastMember; mode: 'story' | 'cast'; voice?: Voice; voicesEnabled: boolean; editable: boolean; tourVoice?: boolean }>();
const emit = defineEmits<{ rematch: []; pickVoice: []; pickLook: [versionId: string]; regenerate: [] }>();

const matchText = computed(() => ({ user: '你选的数字人', ai: 'AI 自动匹配', new: '将新建数字人' })[props.member.matchSource]);
const meta = computed(() => [genderLabel[props.member.gender], ageLabel[props.member.ageGroup]].filter(Boolean).join(' · '));
const versions = computed(() => props.member.look.versions.filter((v) => v.status === 'succeeded'));
const voiceSourceText = computed(() => ({ user: '', ai: 'AI 推荐', default: '默认声音' })[props.member.voice?.source || 'user']);
</script>

<template>
  <div class="row">
    <div class="avatar">
      <img v-if="member.look.imageUrl" :src="member.look.imageUrl" alt="" />
      <van-loading v-else-if="member.look.status === 'generating'" size="20" />
      <van-icon v-else name="user-o" size="24" />
    </div>
    <div class="body">
      <div class="title">
        <strong>{{ member.name }}</strong>
        <span v-if="meta" class="miv-hint">{{ meta }}</span>
      </div>
      <template v-if="mode === 'story'">
        <span :class="['tag', member.matchSource]">{{ matchText }}</span>
        <span v-if="member.look.status === 'missing'" class="miv-hint">· 需要生成形象</span>
      </template>
      <template v-else>
        <span v-if="member.look.status === 'generating'" class="miv-hint">形象生成中…</span>
        <span v-else-if="member.look.status === 'failed'" class="miv-hint warn">形象生成失败，可重新生成</span>
        <div v-if="versions.length > 1" class="versions">
          <button
            v-for="(v, i) in versions"
            :key="v.id"
            type="button"
            :class="{ on: v.id === member.look.versionId }"
            :disabled="!editable"
            :aria-label="`形象第 ${i + 1} 版`"
            @click="emit('pickLook', v.id)"
          >
            <img :src="v.imageUrl" alt="" />
          </button>
        </div>
        <div v-if="voicesEnabled" class="voice" :data-tour="tourVoice ? 'cast-voice' : undefined">
          <van-icon name="volume-o" />
          <span>{{ voice?.name || '未设置' }}</span>
          <span v-if="voiceSourceText" class="tag ai">{{ voiceSourceText }}</span>
          <VoicePlayButton :url="voice?.sampleUrl" />
          <button v-if="editable" type="button" class="link" @click="emit('pickVoice')">更换</button>
        </div>
      </template>
    </div>
    <div class="side">
      <button v-if="mode === 'story' && editable" type="button" class="link" @click="emit('rematch')">更换</button>
      <button v-if="mode === 'cast' && editable && member.look.status !== 'generating'" type="button" class="link" @click="emit('regenerate')">重新生成</button>
    </div>
  </div>
</template>

<style scoped>
.row { display: flex; gap: var(--miv-space-3); padding: var(--miv-space-3) 0; border-bottom: 1px solid var(--miv-border); }
.row:last-child { border-bottom: 0; }
.avatar { flex: none; width: 56px; height: 56px; border-radius: var(--miv-radius-md); overflow: hidden; background: var(--miv-primary-soft); color: var(--miv-primary); display: flex; align-items: center; justify-content: center; }
.avatar img { width: 100%; height: 100%; object-fit: cover; }
.body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: var(--miv-space-1); font-size: 13px; }
.title { display: flex; align-items: baseline; gap: var(--miv-space-2); }
.title strong { font-size: 15px; }
.tag { display: inline-block; width: fit-content; font-size: 11px; padding: 1px 6px; border-radius: 999px; background: var(--miv-bg); color: var(--miv-text-2); }
.tag.ai { background: var(--miv-primary-soft); color: var(--miv-primary-strong); }
.tag.new { background: var(--miv-warning-soft); color: var(--miv-warning); }
.warn { color: var(--miv-danger); }
.versions { display: flex; gap: var(--miv-space-1); }
.versions button { width: 36px; height: 36px; padding: 0; border-radius: var(--miv-radius-sm); overflow: hidden; border: 2px solid transparent; cursor: pointer; background: none; }
.versions button.on { border-color: var(--miv-primary); }
.versions img { width: 100%; height: 100%; object-fit: cover; }
.voice { display: flex; align-items: center; gap: var(--miv-space-1); flex-wrap: wrap; color: var(--miv-text-2); width: fit-content; padding-right: var(--miv-space-1); }
.side { flex: none; display: flex; align-items: flex-start; }
.link { border: 0; background: none; color: var(--miv-primary-strong); font: inherit; font-size: 13px; cursor: pointer; padding: 2px 4px; }
</style>

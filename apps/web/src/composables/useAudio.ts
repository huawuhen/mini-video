import { ref } from 'vue';

// 全站单例播放器：同一时间只播放一个试听；路由切换时由 router.afterEach 调用 stopAudio（docs/UI.md §8）。
const playing = ref<string | null>(null);
let audio: HTMLAudioElement | null = null;

export function stopAudio() {
  audio?.pause();
  playing.value = null;
}
function toggle(url: string) {
  if (playing.value === url) { stopAudio(); return; }
  audio ??= new Audio();
  audio.pause();
  audio.src = url;
  audio.onended = () => { playing.value = null; };
  audio.onerror = () => { playing.value = null; };
  playing.value = url;
  audio.play().catch(() => { playing.value = null; });
}

export function useAudio() {
  return { playing, toggle, stop: stopAudio };
}

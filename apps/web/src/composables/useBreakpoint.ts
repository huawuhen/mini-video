import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

/** docs/UI.md §3 断点：mobile <768，tablet 768–1023，desktop ≥1024。 */
const width = ref(typeof window === 'undefined' ? 375 : window.innerWidth);
let listeners = 0;
const onResize = () => { width.value = window.innerWidth; };

export function useBreakpoint() {
  onMounted(() => { if (listeners++ === 0) window.addEventListener('resize', onResize, { passive: true }); });
  onBeforeUnmount(() => { if (--listeners === 0) window.removeEventListener('resize', onResize); });
  return {
    width,
    isMobile: computed(() => width.value < 768),
    isDesktop: computed(() => width.value >= 1024),
  };
}

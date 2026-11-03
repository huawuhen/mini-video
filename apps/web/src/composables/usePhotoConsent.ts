// 照片单独同意（M3-LEGAL-01）：所有「选照片 / 上传照片」入口之前调用 ensurePhotoConsent()——
// 已同意当前版本直接放行；否则弹层等待用户决定（「不同意」false 不上传；「同意并上传」写记录后 true）。
// 上传接口收到 403 PHOTO_CONSENT_REQUIRED 时调用 retryAfterConsent() 补弹（版本升级等场景）。
import { ref } from 'vue';
import { api } from '@/api';
import { useAuthStore } from '@/stores/auth';

const visible = ref(false);
let resolver: ((agreed: boolean) => void) | null = null;

export function usePhotoConsent() {
  const auth = useAuthStore();

  /** 是否已同意当前照片版本——版本号以服务端返回的 consents.current 为准（复审必改④：
   *  前端不再自带版本常量，避免与服务端/正文三处不同步）。 */
  const consented = () => {
    const c = auth.user?.consents;
    return !!c?.current?.photo && c.photo === c.current.photo;
  };

  function openSheet(): Promise<boolean> {
    visible.value = true;
    return new Promise((resolve) => { resolver = resolve; });
  }

  /** 选照片入口守卫：未同意先弹层。返回 false 时不得打开文件选择器。 */
  async function ensurePhotoConsent(): Promise<boolean> {
    if (consented()) return true;
    return openSheet();
  }

  /** 弹层回调（PhotoConsentSheet 的 decided 事件）：同意后拉一次 me 同步 consents 快照。 */
  async function onDecided(agreed: boolean) {
    if (agreed) {
      try { await auth.check(); } catch { /* 快照刷新失败不阻塞：后续 403 会再兜底 */ }
    }
    resolver?.(agreed);
    resolver = null;
  }

  return { visible, ensurePhotoConsent, onDecided, consented };
}

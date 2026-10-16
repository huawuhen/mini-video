// mock 专用占位素材：渐变 SVG 图片、正弦波 WAV 试听音频（data URI），不依赖外部资源。

export function placeholderImage(label: string, hue = 170, ratio = '1:1'): string {
  const [w, h] = ratio.split(':').map(Number);
  const width = 360;
  const height = Math.round((width * (h || 1)) / (w || 1));
  const safe = label.replace(/[<>&"']/g, '');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="hsl(${hue},70%,86%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360},65%,72%)"/>
</linearGradient></defs>
<rect width="100%" height="100%" fill="url(#g)"/>
<text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" font-family="sans-serif" font-size="22" fill="rgba(31,41,51,0.75)">${safe}</text>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** 生成一段 1.2 秒的「叮咚」试听音（两个音高），用不同频率区分音色。 */
export function placeholderAudio(frequency: number): string {
  const sampleRate = 8000;
  const seconds = 1.2;
  const samples = Math.floor(sampleRate * seconds);
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const writeString = (offset: number, text: string) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
  writeString(0, 'RIFF'); view.setUint32(4, 36 + samples * 2, true); writeString(8, 'WAVE');
  writeString(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  writeString(36, 'data'); view.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate;
    const f = t < seconds / 2 ? frequency : frequency * 0.8;
    const envelope = Math.min(1, t * 20) * Math.exp(-3 * (t % (seconds / 2)));
    view.setInt16(44 + i * 2, Math.sin(2 * Math.PI * f * t) * envelope * 0.4 * 32767, true);
  }
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return `data:audio/wav;base64,${btoa(binary)}`;
}

/** 把用户选择的照片压缩成小尺寸 JPEG data URL，便于存进 localStorage。 */
export function shrinkImage(file: File, maxSize = 320): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片无法读取')); };
    img.src = url;
  });
}

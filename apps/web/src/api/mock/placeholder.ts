// 生成带文字的渐变 SVG 占位图（data URI），mock 专用，不依赖外部图片。
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

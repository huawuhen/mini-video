// 协议正文渲染（M3-LEGAL-01）：正文唯一来源是 docs/legal/*.md（Vite ?raw 构建时导入，
// 不手抄改写）。渲染器只覆盖协议正文用到的语法（标题/引用块/粗体/表格/有序无序列表/段落），
// 不引入通用 Markdown 依赖；Lead 更新正文引入新语法时需同步扩展。
import termsMarkdown from '@legal/user-agreement.md?raw';
import privacyMarkdown from '@legal/privacy-policy.md?raw';
import photoConsentMarkdown from '@legal/photo-consent.md?raw';

export const termsText = termsMarkdown;
export const privacyText = privacyMarkdown;
export const photoConsentText = photoConsentMarkdown;

// 版本常量已删除（M3-LEGAL-01 复审必改④）：判断与提交一律用服务端返回的
// consents.current（见 /api/v1/auth/me、login 响应），避免三处不同步。

const escapeHtml = (text: string) => text
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 行内：**粗体**（协议的重点条款标记）。 */
const inline = (text: string) => escapeHtml(text).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

/** 轻量 Markdown → HTML（仅协议正文语法；输入是仓库内的受信文档，先转义再放行 <strong>）。 */
export function renderLegalMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const html: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  let inTable = false;
  const closeList = () => { if (list) { html.push(`</${list}>`); list = null; } };
  const closeTable = () => { if (inTable) { html.push('</tbody></table>'); inTable = false; } };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { closeList(); closeTable(); continue; }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      closeList(); closeTable();
      const level = Math.min(heading[1].length + 1, 5); // 文档 # → h2（页面标题占 h1）
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      closeList(); closeTable();
      html.push(`<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`);
      continue;
    }
    if (/^\|.*\|$/.test(line.trim())) {
      const cells = line.trim().slice(1, -1).split('|').map((c) => c.trim());
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue; // 分隔行
      if (!inTable) { closeList(); html.push('<table><thead><tr>'); cells.forEach((c) => html.push(`<th>${inline(c)}</th>`)); html.push('</tr></thead><tbody>'); inTable = true; }
      else { html.push('<tr>'); cells.forEach((c) => html.push(`<td>${inline(c)}</td>`)); html.push('</tr>'); }
      continue;
    }
    closeTable();
    const ordered = /^\d+[.、]\s+(.*)$/.exec(line.trim());
    const bullet = /^[-*]\s+(.*)$/.exec(line.trim());
    if (ordered || bullet) {
      const want = ordered ? 'ol' : 'ul';
      if (list !== want) { closeList(); html.push(`<${want}>`); list = want; }
      html.push(`<li>${inline((ordered ?? bullet)![1])}</li>`);
      continue;
    }
    closeList();
    html.push(`<p>${inline(line.trim())}</p>`);
  }
  closeList(); closeTable();
  return html.join('\n');
}

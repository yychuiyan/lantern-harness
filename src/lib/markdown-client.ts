import { Marked } from 'marked';
import DOMPurify from 'dompurify';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 代码块带标题栏与复制按钮（dsh CodeBlock 形态）；复制由对话页事件委托处理 data-copy-code */
const md = new Marked({
  renderer: {
    code({ text, lang, escaped }) {
      const label = escapeHtml((lang ?? '').trim().split(/\s+/)[0] || '代码块');
      const body = escaped ? text : escapeHtml(text);
      return (
        `<div class="code-block"><div class="code-block-head"><span>${label}</span>` +
        `<button type="button" data-copy-code>复制</button></div>` +
        `<pre><code>${body}</code></pre></div>`
      );
    },
    link(token) {
      const href = escapeHtml(token.href || '');
      const titleAttr = token.title ? ` title="${escapeHtml(token.title)}"` : '';
      // marked 会把 this 绑到 Renderer，以正确渲染链接内加粗等

      const label = (this as any).parser.parseInline(token.tokens ?? []);
      return (
        `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer">` + `${label}</a>`
      );
    },
  },
});

/** 单元格纯文本：保留换行（步骤 / 预期），供溢出气泡预览 */
function cellPlainText(el: Element): string {
  const clone = el.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
  return (clone.textContent || '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 给表格单元格包一层可截断锚点，挂 data-hint 供全局气泡预览完整内容。
 * 在浏览器用 DOMParser；Node 自测环境没有 DOMParser 时原样返回。
 */
export function enhanceMarkdownTableCells(html: string): string {
  if (!html.includes('<td') && !html.includes('<th')) return html;
  if (typeof DOMParser === 'undefined') return html;
  const doc = new DOMParser().parseFromString(`<div id="__md_root">${html}</div>`, 'text/html');
  const root = doc.getElementById('__md_root');
  if (!root) return html;
  root.querySelectorAll('table').forEach((table) => {
    if (table.parentElement?.classList.contains('chat-md-table-scroll')) return;
    const scroll = doc.createElement('div');
    scroll.className = 'chat-md-table-scroll';
    table.replaceWith(scroll);
    scroll.appendChild(table);
  });
  root.querySelectorAll('td, th').forEach((cell) => {
    if (cell.querySelector(':scope > .chat-md-cell')) return;
    const plain = cellPlainText(cell);
    if (!plain) return;
    const wrap = doc.createElement('span');
    wrap.className = 'chat-md-cell';
    // 仅在真被截断时出气泡（见 hint-tip 的 data-hint-fit）
    wrap.setAttribute('data-hint-fit', '');
    wrap.setAttribute('data-hint', plain);
    while (cell.firstChild) wrap.appendChild(cell.firstChild);
    cell.appendChild(wrap);
  });
  return root.innerHTML;
}

/**
 * 对话消息的客户端 Markdown 渲染。
 * 必须经 DOMPurify 消毒 —— BYOK 场景下 XSS 即 Key 泄露。
 */
export function renderMarkdown(source: string): string {
  const html = md.parse(source, { async: false }) as string;
  // 保留新窗口打开所需属性；表格溢出预览依赖 data-hint / data-hint-fit
  const clean = DOMPurify.sanitize(html, {
    ADD_ATTR: ['target', 'data-hint', 'data-hint-fit'],
  });
  return enhanceMarkdownTableCells(clean);
}

import { marked } from 'marked';

/** 外链在新窗口打开 */
export function withBlankExternalLinks(html: string): string {
  return html.replace(
    /<a\s+([^>]*?)href="(https?:\/\/[^"]+)"([^>]*)>/gi,
    (_m, pre: string, href: string, post: string) => {
      const attrs = `${pre} ${post}`;
      const hasTarget = /\btarget=/i.test(attrs);
      const hasRel = /\brel=/i.test(attrs);
      return `<a ${pre}href="${href}"${post}${hasTarget ? '' : ' target="_blank"'}${
        hasRel ? '' : ' rel="noopener noreferrer"'
      }>`;
    },
  );
}

/** 「本页目录」条目：来源是正文里的二级 / 三级标题 */
export interface DocTocEntry {
  id: string;
  text: string;
  level: 2 | 3;
}

/** 标题转锚点：保留中英文与数字，其余字符折叠成连字符 */
function slugifyHeading(text: string): string {
  const slug = text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || 'section';
}

/** 给 h2 / h3 补锚点，同时收集本页目录 */
function withHeadingAnchors(html: string): { html: string; toc: DocTocEntry[] } {
  const toc: DocTocEntry[] = [];
  const used = new Map<string, number>();
  const out = html.replace(/<h([23])>([\s\S]*?)<\/h\1>/g, (_m, level: string, inner: string) => {
    const text = inner
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .trim();
    const base = slugifyHeading(text);
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    const id = n === 1 ? base : `${base}-${n}`;
    toc.push({ id, text, level: Number(level) as 2 | 3 });
    return `<h${level} id="${id}">${inner}</h${level}>`;
  });
  return { html: out, toc };
}

/** Markdown → 正文 HTML + 本页目录（h2 / h3 自动补锚点） */
export function renderDoc(md: string): { html: string; toc: DocTocEntry[] } {
  const html = marked.parse(md, { async: false }) as string;
  return withHeadingAnchors(withBlankExternalLinks(html));
}

/** 去掉首个 H1 */
export function stripFirstH1(md: string): string {
  return md.replace(/^#\s+[^\n]+\n+/, '');
}

/**
 * 作曲区粘贴：从剪贴板解析本地路径 / 文件名，映射为文档引用胶囊。
 */

export type PasteDocCollection = 'knowledge' | 'templates' | 'workspace' | 'cases';

export interface PasteDocRef {
  collection: PasteDocCollection;
  id: string;
  title: string;
  category: string;
  path: string;
  format: string;
}

export interface PasteCatalogEntry {
  collection: PasteDocCollection;
  path: string;
  title: string;
  category: string;
  format: string;
}

const DOC_PREFIXES: {
  prefix: string;
  /** 旧目录名（英文），兼容历史路径文本 */
  aliases?: string[];
  collection: PasteDocCollection;
  category: string;
}[] = [
  { prefix: '知识库管理', aliases: ['knowledge'], collection: 'knowledge', category: '知识库' },
  { prefix: '用例管理', aliases: ['cases'], collection: 'cases', category: '用例' },
  { prefix: '测试模板库', aliases: ['templates'], collection: 'templates', category: '模板' },
];

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+/g, '/');
}

export function basenamePath(p: string): string {
  const n = normalizePath(p);
  const i = n.lastIndexOf('/');
  return i >= 0 ? n.slice(i + 1) : n;
}

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : 'file';
}

/** file:// → 本地绝对路径 */
export function decodeFileUrl(raw: string): string | null {
  const t = raw.trim();
  if (!/^file:/i.test(t)) return null;
  try {
    const u = new URL(t);
    let p = decodeURIComponent(u.pathname || '');
    // Windows: /C:/Users/...
    if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
    return normalizePath(p);
  } catch {
    return null;
  }
}

function isAbsoluteFsPath(p: string): boolean {
  const n = normalizePath(p);
  return n.startsWith('/') || /^[A-Za-z]:\//.test(n);
}

/** 单行、带扩展名、无路径分隔 → Finder 常见「只贴文件名」 */
export function looksLikeBareFilename(text: string): boolean {
  const t = text.trim();
  if (!t || t.includes('\n') || /\s/.test(t)) return false;
  if (t.includes('://') || t.includes('/') || t.includes('\\')) return false;
  return /\.[A-Za-z0-9]{1,16}$/.test(t);
}

/** 单行路径形态（绝对 / 相对 / file://） */
export function looksLikeSinglePath(text: string): boolean {
  const t = text.trim();
  if (!t || t.includes('\n')) return false;
  if (/^file:/i.test(t)) return true;
  if (isAbsoluteFsPath(t)) return true;
  // 相对：含分隔且像文件路径
  if ((t.includes('/') || t.includes('\\')) && !/\s/.test(t) && t.length < 512) return true;
  return false;
}

/** 从 DataTransfer 抽出本地路径（uri-list + plain） */
export function extractClipboardFilePaths(cd: DataTransfer): string[] {
  const out: string[] = [];
  const uriList = cd.getData('text/uri-list') || '';
  for (const line of uriList.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const fromUrl = decodeFileUrl(s);
    if (fromUrl) out.push(fromUrl);
    else if (isAbsoluteFsPath(s)) out.push(normalizePath(s));
  }
  const plain = (cd.getData('text/plain') || '').trim();
  if (plain && !plain.includes('\n')) {
    const fromUrl = decodeFileUrl(plain);
    if (fromUrl) out.push(fromUrl);
    else if (looksLikeSinglePath(plain) && !looksLikeBareFilename(plain)) {
      out.push(normalizePath(plain));
    }
  }
  return [...new Set(out)];
}

function toDocRef(e: PasteCatalogEntry): PasteDocRef {
  return {
    collection: e.collection,
    id: `${e.collection}:${e.path}`,
    title: e.title || basenamePath(e.path),
    category: e.category,
    path: e.path,
    format: e.format || extOf(e.path),
  };
}

function stripPrefix(abs: string, root: string): string | null {
  const a = normalizePath(abs);
  const r = normalizePath(root).replace(/\/$/, '');
  if (a === r) return '';
  if (a.startsWith(`${r}/`)) return a.slice(r.length + 1);
  return null;
}

/**
 * 绝对/相对路径 → 文档引用；能落到知识库/用例/提示词/模板/工作区时返回。
 */
export function resolvePathToPasteDocRef(
  rawPath: string,
  opts: {
    projectRoot?: string | null;
    workspace?: string | null;
    workspaceLabel?: string;
  },
): PasteDocRef | null {
  let path = normalizePath(rawPath.trim());
  const fromUrl = decodeFileUrl(path);
  if (fromUrl) path = fromUrl;

  const projectRoot = opts.projectRoot ? normalizePath(opts.projectRoot) : '';
  const workspace = opts.workspace ? normalizePath(opts.workspace) : '';

  let rel = path;
  if (projectRoot) {
    const stripped = stripPrefix(path, projectRoot);
    if (stripped != null) rel = stripped;
  }

  for (const { prefix, aliases, collection, category } of DOC_PREFIXES) {
    for (const p of [prefix, ...(aliases ?? [])]) {
      if (rel === p) continue;
      if (rel.startsWith(`${p}/`)) {
        const inner = rel.slice(p.length + 1);
        if (!inner) continue;
        return toDocRef({
          collection,
          path: inner,
          title: basenamePath(inner),
          category,
          format: extOf(inner),
        });
      }
    }
  }

  if (workspace) {
    const stripped = stripPrefix(path, workspace);
    if (stripped != null && stripped !== '') {
      return toDocRef({
        collection: 'workspace',
        path: stripped,
        title: basenamePath(stripped),
        category: opts.workspaceLabel || '工作区',
        format: extOf(stripped),
      });
    }
  }

  // 已是相对路径且带目录：默认当工作区路径
  if (!isAbsoluteFsPath(rel) && rel.includes('/')) {
    const first = rel.split('/')[0] || '';
    const hit = DOC_PREFIXES.find((d) => d.prefix === first || d.aliases?.includes(first));
    if (hit) {
      const inner = rel.slice(first.length + 1);
      if (inner) {
        return toDocRef({
          collection: hit.collection,
          path: inner,
          title: basenamePath(inner),
          category: hit.category,
          format: extOf(inner),
        });
      }
    }
    return toDocRef({
      collection: 'workspace',
      path: rel,
      title: basenamePath(rel),
      category: opts.workspaceLabel || '工作区',
      format: extOf(rel),
    });
  }

  return null;
}

/** 仅文件名时：在目录里唯一命中则返回引用 */
export function resolveNameToPasteDocRef(
  name: string,
  catalog: PasteCatalogEntry[],
): PasteDocRef | null {
  const key = name.trim();
  if (!key) return null;
  const lower = key.toLowerCase();
  const matches = catalog.filter((d) => {
    const base = basenamePath(d.path).toLowerCase();
    const title = (d.title || '').toLowerCase();
    return base === lower || title === lower || d.path.toLowerCase() === lower;
  });
  if (matches.length !== 1) return null;
  return toDocRef(matches[0]!);
}

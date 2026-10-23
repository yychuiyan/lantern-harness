/**
 * 项目文档库客户端。
 * DocsRoot 为英文逻辑 id；磁盘英文目录、界面中文见 doc-roots.ts。
 * 仅 npm run dev / 本地一体服务可写。
 */

export type DocsRoot = 'requirements' | 'cases' | 'templates' | 'prompts' | 'knowledge';

export interface DocsEntry {
  name: string;
  type: 'dir' | 'file';
  path: string;
  size?: number;
  /** 修改时间 ms */
  mtime?: number;
  /** 文件创建时间 ms（拷贝种子时不低于所在目录的创建时间） */
  ctime?: number;
}

export interface DocsTreeNode {
  name: string;
  path: string;
  /** 该目录下递归的文件总数（用于「名称 (N)」与删除前提示） */
  fileCount?: number;
  children: DocsTreeNode[];
}

function prefixOf(root: DocsRoot): string {
  if (root === 'requirements') return '/__tb_requirements';
  if (root === 'cases') return '/__tb_cases';
  if (root === 'prompts') return '/__tb_prompts';
  if (root === 'knowledge') return '/__tb_knowledge';
  return '/__tb_templates';
}

async function postJson<T>(
  root: DocsRoot,
  pathSuffix: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`${prefixOf(root)}${pathSuffix}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export async function fetchDocsHealth(root: DocsRoot): Promise<boolean> {
  try {
    const res = await fetch(`${prefixOf(root)}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function listDocs(
  root: DocsRoot,
  dirPath = '.',
): Promise<{ path: string; entries: DocsEntry[] }> {
  const data = await postJson<{ path: string; entries: DocsEntry[] }>(root, '/list', {
    path: dirPath,
  });
  return { path: data.path, entries: data.entries ?? [] };
}

/** Office / WPS / LibreOffice 打开文件时生成的锁文件与临时文件（如 ~$xxx.docx） */
export function isOfficeLockFile(name: string): boolean {
  return name.startsWith('~$') || name.startsWith('~WRL') || name.startsWith('.~lock.');
}

/** 拉取文件夹树；totalFiles 为根目录递归文件总数（用于「全部 XX (N)」） */
export async function fetchDocsTree(
  root: DocsRoot,
): Promise<{ tree: DocsTreeNode[]; totalFiles: number }> {
  const res = await fetch(`${prefixOf(root)}/tree`, { signal: AbortSignal.timeout(3000) });
  const data = (await res.json()) as {
    ok?: boolean;
    tree?: DocsTreeNode[];
    totalFiles?: number;
    error?: string;
  };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return { tree: data.tree ?? [], totalFiles: data.totalFiles ?? 0 };
}

export async function mkdirDocs(root: DocsRoot, parent: string, name: string): Promise<string> {
  const data = await postJson<{ path: string }>(root, '/mkdir', { parent, name });
  return data.path;
}

export async function uploadDocsFile(
  root: DocsRoot,
  parent: string,
  file: File,
): Promise<{ path: string; size: number }> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  const contentBase64 = btoa(binary);
  return postJson(root, '/upload', {
    parent,
    name: file.name,
    contentBase64,
  });
}

export async function readDocsText(
  root: DocsRoot,
  filePath: string,
): Promise<{ path: string; content: string; encoding: string }> {
  const data = await postJson<{
    path: string;
    content?: string;
    encoding: string;
    contentBase64?: string;
  }>(root, '/read', { path: filePath });
  if (data.encoding === 'utf-8' && typeof data.content === 'string') {
    return { path: data.path, content: data.content, encoding: data.encoding };
  }
  throw new Error('该文件不是可预览的文本');
}

/** 读取原始内容（文本或 base64） */
export async function readDocsRaw(
  root: DocsRoot,
  filePath: string,
): Promise<{
  path: string;
  encoding: 'utf-8' | 'base64';
  content?: string;
  contentBase64?: string;
}> {
  const data = await postJson<{
    path: string;
    content?: string;
    encoding: string;
    contentBase64?: string;
  }>(root, '/read', { path: filePath });
  if (data.encoding === 'utf-8' && typeof data.content === 'string') {
    return { path: data.path, encoding: 'utf-8', content: data.content };
  }
  if (typeof data.contentBase64 === 'string') {
    return { path: data.path, encoding: 'base64', contentBase64: data.contentBase64 };
  }
  throw new Error('无法读取文件');
}

export async function writeDocsText(
  root: DocsRoot,
  filePath: string,
  content: string,
): Promise<void> {
  await postJson(root, '/write-text', { path: filePath, content });
}

export async function writeDocsBinary(
  root: DocsRoot,
  filePath: string,
  contentBase64: string,
): Promise<void> {
  await postJson(root, '/write-binary', { path: filePath, contentBase64 });
}

/** 删除文件或目录；目录非空时后端会拒绝，需先清空内部内容 */
export async function deleteDocs(root: DocsRoot, targetPath: string): Promise<void> {
  await postJson(root, '/delete', { path: targetPath });
}

/** 重命名文件或目录，返回新的相对路径 */
export async function renameDocs(
  root: DocsRoot,
  targetPath: string,
  name: string,
): Promise<string> {
  const data = await postJson<{ path: string }>(root, '/rename', { path: targetPath, name });
  return data.path;
}

/** 取父目录相对路径；顶级项返回 '.' */
export function parentDirPath(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '.' : p.slice(0, i);
}

/** child 是否等于 ancestor，或位于其下 */
export function isPathUnder(child: string, ancestor: string): boolean {
  return child === ancestor || child.startsWith(`${ancestor}/`);
}

/** 路径重映射：位于 oldPrefix 之下时换成 newPrefix 对应位置 */
export function remapPath(p: string, oldPrefix: string, newPrefix: string): string {
  return isPathUnder(p, oldPrefix) ? newPrefix + p.slice(oldPrefix.length) : p;
}

/** 按相对路径在文件夹树中查找目录节点（含各目录已算好的递归文件数） */
export function findTreeNode(tree: DocsTreeNode[], path: string): DocsTreeNode | null {
  for (const n of tree) {
    if (n.path === path) return n;
    const hit = findTreeNode(n.children, path);
    if (hit) return hit;
  }
  return null;
}

/** 递归统计目录节点下的子目录数量（配合 fileCount 生成删除前的提示） */
export function countTreeDirs(node: DocsTreeNode): number {
  let dirs = 0;
  for (const c of node.children) dirs += 1 + countTreeDirs(c);
  return dirs;
}

/** 用本机默认程序打开文件（仅 npm run dev） */
export async function openDocsFile(root: DocsRoot, filePath: string): Promise<void> {
  await postJson(root, '/open', { path: filePath });
}

export function fileToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

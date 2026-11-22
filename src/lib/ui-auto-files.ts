/**
 * 自动化项目文件浏览 / 读写（生成 Tab 文件树）。
 * 正式源码默认只读；草稿与待写入路径可由前端决定是否 PUT。
 */
import { UI_AUTO_API } from './ui-auto';

export interface UiProjectFileNode {
  path: string;
  name: string;
  dir: boolean;
  bytes?: number;
  children?: UiProjectFileNode[];
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function listProjectFiles(projectId: string): Promise<{
  ok: boolean;
  root?: string;
  tree?: UiProjectFileNode[];
  error?: string;
}> {
  const url = `${UI_AUTO_API}/project/files?projectId=${encodeURIComponent(projectId)}`;
  const res = await fetch(url, { credentials: 'same-origin' });
  const data = await readJson(res);
  if (!res.ok || data.ok === false) {
    const fallback =
      res.status === 404
        ? '文件接口未就绪（HTTP 404），请重启 lantern 服务后再刷新'
        : `HTTP ${res.status}`;
    return { ok: false, error: String(data.error || fallback) };
  }
  return {
    ok: true,
    root: typeof data.root === 'string' ? data.root : undefined,
    tree: Array.isArray(data.tree) ? (data.tree as UiProjectFileNode[]) : [],
  };
}

export async function readProjectFile(
  projectId: string,
  relPath: string,
): Promise<{ ok: boolean; path?: string; content?: string; bytes?: number; error?: string }> {
  const url = `${UI_AUTO_API}/project/file?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(relPath)}`;
  const res = await fetch(url, { credentials: 'same-origin' });
  const data = await readJson(res);
  if (!res.ok || data.ok === false) {
    return { ok: false, error: String(data.error || `HTTP ${res.status}`) };
  }
  return {
    ok: true,
    path: typeof data.path === 'string' ? data.path : relPath,
    content: typeof data.content === 'string' ? data.content : '',
    bytes: typeof data.bytes === 'number' ? data.bytes : undefined,
  };
}

export async function writeProjectFile(input: {
  projectId: string;
  path: string;
  content: string;
  /** 仅允许写草稿区或显式允许的相对路径 */
  allow?: 'draft' | 'any';
}): Promise<{ ok: boolean; path?: string; error?: string }> {
  const res = await fetch(`${UI_AUTO_API}/project/file`, {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const data = await readJson(res);
  if (!res.ok || data.ok === false) {
    return { ok: false, error: String(data.error || `HTTP ${res.status}`) };
  }
  return { ok: true, path: typeof data.path === 'string' ? data.path : input.path };
}

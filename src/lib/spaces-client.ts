/**
 * 数据空间客户端：列表 / 切换 / 增删改 / 复制 / 导入导出。
 *
 * 这些路由挂在服务根（`/__tb_spaces`）而不是站点 base 下，
 * 与 `session-runs-client` 一致，因此直接用绝对路径。
 */
import { flushAppConfig } from './app-config';
import { t } from './i18n';
import { rememberActiveSpaceId } from './space-scope';

const API = '/__tb_spaces';

export interface SpaceInfo {
  id: string;
  name: string;
  path: string;
  createdAt?: number;
  isPublic: boolean;
  isActive: boolean;
  exists: boolean;
  removable: boolean;
  /** 用户手工纳入的普通文件夹：不写空间元数据 */
  external?: boolean;
  /** 仅当请求 stats=1 时才有值（统计体积要遍历目录，较慢） */
  bytes: number | null;
}

export interface SpaceList {
  ok: boolean;
  error?: string;
  baseRoot: string;
  dataRoot: string;
  activeId: string;
  managedParent: string;
  publicName: string;
  spaces: SpaceInfo[];
}

export interface SpaceResult {
  ok: boolean;
  error?: string;
  space?: SpaceInfo;
  switched?: boolean;
  warning?: string;
  purged?: boolean;
  dataRoot?: string;
}

/** 空间详情：编辑面板用的名称 / 提示词要求 / 默认提示词 */
export interface SpaceDetail extends SpaceResult {
  brief?: string;
  systemPrompt?: string;
}

/** 扫描托管目录的返回：added 为新纳入的空间，backfilled 为补写清单的已有空间 */
export interface SpaceDiscoverResult {
  ok: boolean;
  error?: string;
  managedParent?: string;
  added?: Array<{ id: string; name: string; path: string; external?: boolean }>;
  backfilled?: string[];
  skipped?: Array<{ path: string; reason: string }>;
  /** 不是数据空间、等待用户确认是否纳入的文件夹 */
  candidates?: Array<{ path: string; name: string; hasContent?: boolean }>;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    const data = (await res.json()) as T & { error?: string };
    if (!res.ok) {
      return { ok: false, error: data?.error || `请求失败（HTTP ${res.status}）` } as T;
    }
    return data;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) } as T;
  }
}

/** 服务端是否提供数据空间接口（静态部署时为 false） */
export async function spacesAvailable(signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch(API, { signal: signal ?? AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function listSpaces(opts?: { stats?: boolean }): Promise<SpaceList | null> {
  try {
    const url = opts?.stats ? `${API}?stats=1` : API;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = (await res.json()) as SpaceList;
    if (data?.activeId) rememberActiveSpaceId(data.activeId);
    return data;
  } catch {
    return null;
  }
}

export async function switchSpace(id: string): Promise<SpaceResult> {
  await flushAppConfig();
  const out = await postJson<SpaceResult>(`${API}/switch`, { id });
  if (out.ok) rememberActiveSpaceId(id);
  return out;
}

export function createSpace(
  name: string,
  opts?: { managedParent?: string; switch?: boolean; systemPrompt?: string; promptBrief?: string },
) {
  return postJson<SpaceResult>(`${API}/create`, {
    name,
    managedParent: opts?.managedParent,
    switch: opts?.switch === true,
    systemPrompt: opts?.systemPrompt,
    promptBrief: opts?.promptBrief,
  });
}

export function renameSpace(id: string, name: string): Promise<SpaceResult> {
  return postJson<SpaceResult>(`${API}/rename`, { id, name });
}

/**
 * 空间接口的旧版本兜底：老服务没有 /detail、/update 路由时会回 `{error:'not found'}`，
 * 直接显示「not found」会让人以为空间丢了，这里换成可操作的提示。
 */
function describeSpaceApiError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error ?? '');
  if (!text.trim() || /^not found$/i.test(text.trim())) {
    return '本地服务版本较旧，还没有空间编辑接口；请重启本地服务后再试';
  }
  return text;
}

/** 读取空间详情（名称 / 提示词要求 / 默认提示词） */
export async function fetchSpaceDetail(id: string): Promise<SpaceDetail> {
  try {
    const res = await fetch(`${API}/detail?id=${encodeURIComponent(id)}`);
    const data = (await res.json()) as SpaceDetail & { error?: string };
    if (!res.ok) {
      return { ok: false, error: describeSpaceApiError(data?.error ?? `HTTP ${res.status}`) };
    }
    return data;
  } catch (e) {
    return { ok: false, error: describeSpaceApiError(e) };
  }
}

/** 保存空间名称 / 提示词要求 / 默认提示词 */
export async function updateSpace(
  id: string,
  patch: { name?: string; brief?: string; systemPrompt?: string },
): Promise<SpaceDetail> {
  const out = await postJson<SpaceDetail>(`${API}/update`, { id, ...patch });
  if (!out.ok) return { ...out, error: describeSpaceApiError(out.error) };
  return out;
}

export function copySpace(id: string, name: string): Promise<SpaceResult> {
  return postJson<SpaceResult>(`${API}/copy`, { id, name });
}

/**
 * @param purge true 时连磁盘数据一起删除，必须同时 confirm=true
 */
export function deleteSpace(id: string, purge: boolean): Promise<SpaceResult> {
  return postJson<SpaceResult>(`${API}/delete`, { id, purge, confirm: purge === true });
}

export function validateSpaceName(
  name: string,
): Promise<{ ok: boolean; name?: string; error?: string }> {
  return postJson<{ ok: boolean; name?: string; error?: string }>(`${API}/validate-name`, { name });
}

/** 导出范围：content 排除密钥 / 会话 / 记忆 / 缓存 */
export type ExportScope = 'full' | 'content';

/** 导出为 zip 并触发浏览器下载 */
export function exportSpaceHref(id: string, scope: ExportScope = 'full'): string {
  const suffix = scope === 'content' ? '&scope=content' : '';
  return `${API}/export?id=${encodeURIComponent(id)}${suffix}`;
}

/**
 * 扫描托管目录，纳入带清单的空间文件夹（整体拷贝进来的空间靠这里被识别）。
 * @param adopt 用户确认纳入的普通文件夹：只登记进列表，不往文件夹里写元数据
 */
export function discoverSpaces(adopt?: string[]): Promise<SpaceDiscoverResult> {
  return postJson<SpaceDiscoverResult>(
    `${API}/discover`,
    Array.isArray(adopt) && adopt.length ? { adopt } : {},
  );
}

/** 导入 zip：文件转 base64 后提交（服务端只接受 JSON 体） */
export async function importSpace(file: File, name?: string): Promise<SpaceResult> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  // 分块拼接，避免超大文件一次性展开成巨型中间字符串
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  const zipBase64 = btoa(binary);
  return postJson<SpaceResult>(`${API}/import`, { zipBase64, name });
}

/** 公共空间界面名：磁盘与展示都是「公共空间」，列表用「默认」标签区分 */
export function displaySpaceName(s: Pick<SpaceInfo, 'name' | 'isPublic'>): string {
  return s.isPublic ? t('space.publicName') : s.name;
}

/**
 * 界面路径：隐去中间的「空间池」目录。
 * 不从 space-layout.mjs 引入：那份模块会读磁盘，进不了浏览器岛屿。
 */
export function displaySpacePath(absPath: string, baseRoot: string): string {
  const sep = absPath.includes('\\') ? '\\' : '/';
  const root = baseRoot.replace(/[/\\]+$/, '');
  const pool = `${root}${sep}空间池`;
  if (absPath === pool) return root;
  const prefix = `${pool}${sep}`;
  if (absPath.startsWith(prefix)) return `${root}${sep}${absPath.slice(prefix.length)}`;
  return absPath;
}

/** 格式化体积（列表里的 bytes 可能为 null） */
export function formatBytes(n: number | null | undefined): string {
  if (!n || n <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/**
 * Agent 策略解析（与 src/lib/agent-policy.ts 语义对齐）。
 * CLI / headless 用本文件，避免运行时依赖 TS 编译。
 */

const ACCESS = new Set(['readonly', 'readwrite', 'full']);
const TOOLS = new Set(['none', 'fs-readonly', 'fs']);

export function parseAccessLevel(raw, fallback = 'readonly') {
  const v = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (ACCESS.has(v)) return v;
  return fallback;
}

export function parseToolProfile(raw, fallback = 'none') {
  const v = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-');
  if (v === 'readonly' || v === 'fs-ro') return 'fs-readonly';
  if (v === 'true' || v === '1' || v === 'yes') return 'fs-readonly';
  if (v === 'false' || v === '0' || v === 'no' || v === 'off') return 'none';
  if (TOOLS.has(v)) return v;
  return fallback;
}

/**
 * @param {{
 *   configAccess?: unknown,
 *   cliAccess?: unknown,
 *   cliToolProfile?: unknown,
 *   workspace?: unknown,
 *   defaultAccess?: string,
 *   defaultToolProfile?: string,
 * }} input
 */
export function resolveAgentPolicy(input = {}) {
  const defaultAccess = input.defaultAccess || 'readonly';
  const access = parseAccessLevel(
    input.cliAccess !== undefined && String(input.cliAccess).trim() !== ''
      ? input.cliAccess
      : input.configAccess,
    defaultAccess,
  );
  let toolProfile = parseToolProfile(input.cliToolProfile, input.defaultToolProfile || 'none');
  if (access === 'readonly' && toolProfile === 'fs') {
    toolProfile = 'fs-readonly';
  }
  const workspace = String(input.workspace ?? '').trim();
  return { access, workspace, toolProfile };
}

/** 从空间 app.config / defaults 读出 access 字段（若有） */
export function readSpaceAccess(localConfig, defaultsConfig) {
  const local = localConfig && typeof localConfig === 'object' ? localConfig : {};
  const defaults = defaultsConfig && typeof defaultsConfig === 'object' ? defaultsConfig : {};
  return local.access ?? defaults.access ?? local.general?.access ?? defaults.general?.access;
}

/**
 * Agent 策略解析：Web / headless / ask / rpc / acp 共用语义。
 * CLI 侧见 cli/agent-policy.mjs（保持同步）。
 */
export type AccessLevel = 'readonly' | 'readwrite' | 'full';
export type ToolProfile = 'none' | 'fs-readonly' | 'fs';

export interface AgentPolicy {
  access: AccessLevel;
  workspace: string;
  toolProfile: ToolProfile;
}

const ACCESS = new Set<AccessLevel>(['readonly', 'readwrite', 'full']);
const TOOLS = new Set<ToolProfile>(['none', 'fs-readonly', 'fs']);

export function parseAccessLevel(raw: unknown, fallback: AccessLevel = 'readonly'): AccessLevel {
  const v = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (ACCESS.has(v as AccessLevel)) return v as AccessLevel;
  return fallback;
}

export function parseToolProfile(raw: unknown, fallback: ToolProfile = 'none'): ToolProfile {
  const v = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-');
  if (v === 'readonly' || v === 'fs-ro') return 'fs-readonly';
  if (v === 'true' || v === '1' || v === 'yes') return 'fs-readonly';
  if (v === 'false' || v === '0' || v === 'no' || v === 'off') return 'none';
  if (TOOLS.has(v as ToolProfile)) return v as ToolProfile;
  return fallback;
}

/**
 * 合并配置默认值与 CLI 覆盖。
 * - access：CLI > 空间配置 > fallback
 * - toolProfile：CLI > defaultToolProfile（各入口不同：ask=none，acp 可开 fs-readonly）
 * - readonly access 时，fs 写档降为 fs-readonly / none 保持
 */
export function resolveAgentPolicy(input: {
  configAccess?: unknown;
  cliAccess?: unknown;
  cliToolProfile?: unknown;
  workspace?: unknown;
  defaultAccess?: AccessLevel;
  defaultToolProfile?: ToolProfile;
}): AgentPolicy {
  const defaultAccess = input.defaultAccess ?? 'readonly';
  const access = parseAccessLevel(
    input.cliAccess !== undefined && String(input.cliAccess).trim() !== ''
      ? input.cliAccess
      : input.configAccess,
    defaultAccess,
  );
  let toolProfile = parseToolProfile(input.cliToolProfile, input.defaultToolProfile ?? 'none');
  if (access === 'readonly' && toolProfile === 'fs') {
    toolProfile = 'fs-readonly';
  }
  const workspace = String(input.workspace ?? '').trim();
  return { access, workspace, toolProfile };
}

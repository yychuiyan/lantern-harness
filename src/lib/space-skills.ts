export interface SpaceSkill {
  id: string;
  key: string;
  group: string;
  name: string;
  variant: string;
  owner: string;
  pluginRefs: string[];
  source: 'bundled' | 'prompt' | 'custom' | 'imported' | string;
  system: boolean;
  kind: string;
  description: string;
  enabled: boolean;
  active: boolean;
  pluginActive: boolean;
  foundation: boolean;
  version: number;
  legacyPath: string;
  updatedAt: string;
}
export interface SkillDetail extends SpaceSkill {
  content: string;
  instructions: string;
  hash: string;
  resources: string[];
}
export async function skillRequest<T>(
  action: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const res = await fetch('/__tb_fs/skill-store', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...args }),
    signal: AbortSignal.timeout(30000),
  });
  const data = await res.json();
  // validate uses ok=false for a valid request with validation errors.
  if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
  return data as T;
}
export const syncPluginSkills = (owner: string, enabled: boolean) =>
  skillRequest('lifecycle', { owner, enabled });

/** 插件仓库在未进入技能页时也要显示技能分组数。 */
export async function fetchSpaceSkillGroupCount(): Promise<number> {
  await skillRequest('migrate');
  const data = await skillRequest<{ skills: SpaceSkill[] }>('list');
  return new Set(data.skills.map((skill) => skill.group)).size;
}

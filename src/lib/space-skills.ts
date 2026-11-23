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

/** 可供业务插件挂载的技能：使用兼容 legacyPath 作为现有配置值。 */
export async function listMountableSkills(owner?: string): Promise<SpaceSkill[]> {
  await skillRequest('migrate');
  const data = await skillRequest<{ skills: SpaceSkill[] }>('list');
  return data.skills
    .filter(
      (skill) =>
        Boolean(skill.legacyPath) &&
        skill.enabled &&
        (!owner ||
          skill.pluginRefs.includes(owner) ||
          skill.owner === owner ||
          skill.pluginRefs.length === 0),
    )
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

/** 新建技能并返回兼容挂载路径；技能页是后续唯一编辑入口。 */
export async function createMountableSkill(name: string, content: string): Promise<string> {
  const data = await skillRequest<{ skill: SkillDetail }>('create', { name, content });
  if (!data.skill.legacyPath) throw new Error('技能未生成兼容挂载路径');
  return data.skill.legacyPath;
}

/** 确保插件内置技能存在；未改过的种子随代码升级，用户修改保持不动。 */
export async function ensureMountableSkillSeed(
  name: string,
  content: string,
  owner: string,
): Promise<string> {
  const data = await skillRequest<{ legacyPath: string }>('ensure-seed', {
    name,
    content,
    owner,
  });
  return data.legacyPath;
}

/** 读取挂载技能正文；legacyPath 只为兼容已有插件配置。 */
export async function readMountableSkill(legacyPath: string): Promise<string> {
  await skillRequest('migrate');
  const data = await skillRequest<{ skills: SpaceSkill[] }>('list');
  const skill = data.skills.find((item) => item.legacyPath === legacyPath);
  if (!skill) throw new Error('默认技能不存在，请重新打开插件或到技能页启用');
  const detail = await skillRequest<{ skill: SkillDetail }>('read', { id: skill.id });
  return detail.skill.content;
}

/** 某个插件直接推荐或拥有的启用技能。 */
export async function listPluginSkills(owner: string): Promise<SpaceSkill[]> {
  await skillRequest('migrate');
  const data = await skillRequest<{ skills: SpaceSkill[] }>('list');
  return data.skills.filter(
    (skill) => skill.enabled && (skill.owner === owner || skill.pluginRefs.includes(owner)),
  );
}

/**
 * 按插件自动解析默认技能。
 * 传入的兼容路径只用于同组内优先选择，例如功能 / 接口 / 性能 / 自动化用例变体。
 */
export async function resolvePluginSkill(
  owner: string,
  preferredLegacyPaths: readonly string[] = [],
): Promise<{ skill: SpaceSkill; content: string } | null> {
  const skills = await listPluginSkills(owner);
  if (!skills.length) return null;
  const preferred = new Set(preferredLegacyPaths.map((item) => item.trim()).filter(Boolean));
  const skill =
    skills.find((item) => preferred.has(item.legacyPath)) ||
    skills.find((item) => preferred.has(item.name)) ||
    skills[0];
  if (!skill) return null;
  const detail = await skillRequest<{ skill: SkillDetail }>('read', { id: skill.id });
  return { skill, content: detail.skill.content };
}

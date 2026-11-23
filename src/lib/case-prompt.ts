/**
 * 「生成测试用例」的技能资源：技能页是唯一编辑入口。
 *
 * 每个用例类型由插件自动解析默认技能，页面不再提供手动挂载。
 */
import {
  ensureMountableSkillSeed,
  listPluginSkills,
  resolvePluginSkill,
  type SpaceSkill,
} from './space-skills';

export const CASE_PROMPT_FILES = {
  functional: '功能测试用例提示词.md',
  api: '接口测试用例提示词.md',
  performance: '性能测试用例提示词.md',
  automation: '自动化测试用例提示词.md',
} as const;

const CASE_PROMPT_SKILLS = [
  {
    id: 'functional',
    file: CASE_PROMPT_FILES.functional,
    name: '功能用例设计',
    focus: '逐条覆盖需求 / 用户故事、业务流程、边界值、异常和业务规则。',
  },
  {
    id: 'api',
    file: CASE_PROMPT_FILES.api,
    name: '接口用例设计',
    focus: '覆盖鉴权、参数校验、状态码、响应结构、幂等、错误分支与契约约束。',
  },
  {
    id: 'performance',
    file: CASE_PROMPT_FILES.performance,
    name: '性能用例设计',
    focus: '覆盖负载模型、并发、持续时间、指标阈值、监控口径和异常恢复。',
  },
  {
    id: 'automation',
    file: CASE_PROMPT_FILES.automation,
    name: '自动化用例设计',
    focus: '覆盖可自动化步骤、稳定定位、断言、数据准备、清理和失败取证。',
  },
] as const;

/** 新建提示词时的空白骨架（`## 生成用例` 段就是本轮的系统提示词） */
export function buildCasePromptSkeleton(
  name: string,
  focus = '逐条覆盖需求、边界、异常与业务规则。',
): string {
  const title = name.replace(/\.md$/i, '').trim() || '用例生成提示词';
  return [
    `# ${title}`,
    '',
    '> 用例生成提示词：确认后本轮只按这份提示词写用例，工作台的系统提示词不再叠加。',
    '',
    '## 生成用例',
    '',
    '- 逐条覆盖需求 / 用户故事，一条用例只验一个点，不合并步骤；',
    '- 前置条件、操作步骤、预期结果要一一对应，步骤给人看也能照着执行；',
    `- ${focus}`,
    '- 每条用例标注优先级 P0–P3，P0 放主流程与核心校验；',
    '- 字段与顺序严格跟随用例模板；Ideal 表时「模块」=大模块、「子模块」=小模块原文，并按小模块行序输出；',
    '- 「引用需求点」只填材料里真实的 RO-… id，格式「RO-id 标题或原文」；不要填 US-… / TP-…；补充场景同引用并在「备注」写「补充：…」；',
    '- 「待业务确认」类不确定项也要写成用例，并在「备注」标注「待业务确认：…」，不要只写进未覆盖说明；',
    '',
  ].join('\n');
}

/** 插件开启时补齐四类默认用例技能；已有内容不覆盖。 */
export async function ensureCasePromptSkills(): Promise<SpaceSkill[]> {
  let skills = await listPluginSkills('caseGen');
  const have = new Set(skills.map((skill) => skill.legacyPath));
  for (const item of CASE_PROMPT_SKILLS) {
    if (have.has(item.file)) continue;
    const legacyPath = await ensureMountableSkillSeed(
      item.file,
      buildCasePromptSkeleton(item.file, item.focus),
      'caseGen',
    );
    have.add(legacyPath);
  }
  skills = await listPluginSkills('caseGen');
  return skills;
}

/** 根据用例类型自动选择默认技能，不再由页面手动挂载。 */
export async function resolveCasePromptSkill(
  caseType: string,
  caseLabel = '',
): Promise<{ skill: SpaceSkill; content: string }> {
  const haystack = `${caseType} ${caseLabel}`.toLowerCase();
  const matched = CASE_PROMPT_SKILLS.find((item) => item.id === caseType)?.file;
  const inferred = /性能|performance|perf/.test(haystack)
    ? CASE_PROMPT_FILES.performance
    : /接口|api/.test(haystack)
      ? CASE_PROMPT_FILES.api
      : /自动化|automation|e2e/.test(haystack)
        ? CASE_PROMPT_FILES.automation
        : CASE_PROMPT_FILES.functional;
  const preferred = matched ?? inferred;
  let resolved = await resolvePluginSkill('caseGen', [
    preferred,
    ...CASE_PROMPT_SKILLS.map((item) => item.file),
  ]);
  if (!resolved) {
    await ensureCasePromptSkills();
    resolved = await resolvePluginSkill('caseGen', [
      preferred,
      ...CASE_PROMPT_SKILLS.map((item) => item.file),
    ]);
  }
  if (!resolved) throw new Error('生成测试用例技能尚未就绪，请重新打开插件');
  return resolved;
}

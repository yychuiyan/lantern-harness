import type { SkillDetail, SpaceSkill } from './space-skills';

interface PreviewSkill {
  path: string;
  owner: string;
  title: string;
  description: string;
}

const PREVIEW_SKILLS: PreviewSkill[] = [
  ['功能测试用例提示词.md', 'caseGen', '功能测试用例技能', '按需求编写功能测试用例并校验覆盖。'],
  [
    '接口测试用例提示词.md',
    'caseGen',
    '接口测试用例技能',
    '围绕接口契约、鉴权、参数和异常设计接口用例。',
  ],
  [
    '性能测试用例提示词.md',
    'caseGen',
    '性能测试用例技能',
    '按目标、负载模型和指标口径设计性能场景。',
  ],
  ['自动化测试用例提示词.md', 'caseGen', '自动化测试用例技能', '评估可自动化性并设计步骤与断言。'],
  [
    '知识库生成提示词.md',
    'knowledgeGen',
    '知识库生成技能',
    '整理规范、方法论和环境约定并生成知识文档。',
  ],
  ['工作汇报提示词.md', 'reports', '工作汇报技能', '按周期和既定口径汇总工作材料。'],
  ['自动化执行提示词.md', 'uiAuto', '自动化生成与执行技能', '规划、探索并生成 UI 自动化脚本。'],
  ['自动化项目提示词.md', 'uiAuto', '自动化项目创建技能', '体检骨架并补全项目必要配置。'],
  ['需求分析提示词.md', 'reqAnalysis', '需求分析技能', '拆解需求条目、用户故事和测试点。'],
  ['原文结构提示词.md', 'reqAnalysis', '原文结构提取技能', '保留需求文档原始章节和条目层级。'],
  ['需求拆解库提示词.md', 'reqBreakdowns', '需求拆解技能', '把需求结构整理为可编辑 XMind。'],
  [
    '业务地图识别提示词.md',
    'businessMap',
    '业务地图识别技能',
    '从页面、资料和源码识别功能与流程。',
  ],
  ['用户故事审查提示词.md', 'storyReview', '用户故事审查技能', '检查用户故事的可验证性和缺口。'],
  ['测试点生成提示词.md', 'testPoints', '测试点生成技能', '按五维方法拆解测试点并标注优先级。'],
  [
    '用例质量评审提示词.md',
    'caseReview',
    '用例质量评审技能',
    '按覆盖、步骤、预期、数据和规范评分。',
  ],
  [
    '场景遗漏补全提示词.md',
    'caseBlindspot',
    '场景遗漏补全技能',
    '识别非功能、安全、兼容性和隐藏业务场景。',
  ],
  ['用例执行提示词.md', 'caseExecution', '用例执行技能', '按证据执行单条用例并给出可核验结果。'],
  [
    '功能测试报告提示词.md',
    'testReports',
    '功能测试报告技能',
    '整理功能执行事实、缺陷和遗留风险。',
  ],
  ['接口测试报告提示词.md', 'testReports', '接口测试报告技能', '整理接口覆盖、断言和执行结果。'],
  [
    '性能测试报告提示词.md',
    'testReports',
    '性能测试报告技能',
    '整理负载模型、指标、资源和瓶颈证据。',
  ],
].map(([path, owner, title, description]) => ({
  path: path!,
  owner: owner!,
  title: title!,
  description: description!,
}));

function previewSkill(item: PreviewSkill, index: number): SpaceSkill {
  return {
    id: `preview:${index + 1}`,
    key: `preview:${index + 1}`,
    group: item.title,
    name: item.title,
    variant: '在线预览',
    owner: item.owner,
    pluginRefs: [item.owner],
    source: 'bundled',
    system: true,
    kind: 'skill',
    description: item.description,
    enabled: true,
    active: true,
    pluginActive: true,
    foundation: false,
    version: 1,
    legacyPath: item.path,
    updatedAt: '',
  };
}

function findPreview(id: string): SpaceSkill | null {
  const normalized = id.replace(/^space:/, '');
  return (
    PREVIEW_SKILLS.map(previewSkill).find(
      (item) => item.id === normalized || item.key === normalized || item.legacyPath === normalized,
    ) || null
  );
}

function previewDetail(skill: SpaceSkill): SkillDetail {
  return {
    ...skill,
    content: `# ${skill.name}\n\n> 在线只读预览仅展示技能目录。完整技能正文、版本历史和编辑能力请在本地部署中查看。`,
    instructions: '',
    hash: `preview-${skill.id}`,
    resources: ['SKILL.md'],
  };
}

const READ_ONLY_ACTIONS = new Set([
  'migrate',
  'rollback-migration',
  'list',
  'read',
  'history',
  'ensure-seed',
]);

/** GitHub Pages 等静态部署只提供技能目录预览，不落任何数据。 */
export function browserSkillAction(action: string, args: Record<string, unknown>): unknown {
  if (action === 'migrate' || action === 'rollback-migration') return { ok: true };
  if (action === 'list') {
    return { ok: true, skills: PREVIEW_SKILLS.map(previewSkill) };
  }
  if (action === 'read') {
    const skill = findPreview(String(args.id || ''));
    if (!skill) throw new Error('预览技能不存在');
    return { ok: true, skill: previewDetail(skill) };
  }
  if (action === 'history') return { ok: true, versions: [1] };
  if (action === 'ensure-seed') {
    const name = String(args.name || '').trim();
    const existing = PREVIEW_SKILLS.find((item) => item.path === name || item.title === name);
    return { ok: true, legacyPath: existing?.path || name };
  }
  if (!READ_ONLY_ACTIONS.has(action)) {
    throw new Error('当前是在线只读预览，技能修改请使用本地部署');
  }
  throw new Error(`在线只读预览暂不支持：${action}`);
}

/**
 * 报告管理：三类归档目录 + 按类型关联技能（本机按空间记住）。
 */
import { ensureMountableSkillSeed } from './space-skills';

export type TestReportKind = 'functional' | 'api' | 'perf';

export interface TestReportKindDef {
  id: TestReportKind;
  /** 固定页面的 URL 片段 */
  slug: string;
  /** 磁盘子目录名 */
  folder: string;
  label: string;
  /** 开关联动时补种的默认技能兼容路径 */
  defaultPrompt: string;
}

export const TEST_REPORT_KINDS: readonly TestReportKindDef[] = [
  {
    id: 'functional',
    slug: 'functional',
    folder: '功能测试报告',
    label: '功能测试报告',
    defaultPrompt: '功能测试报告提示词.md',
  },
  {
    id: 'api',
    slug: 'api',
    folder: '接口测试报告',
    label: '接口测试报告',
    defaultPrompt: '接口测试报告提示词.md',
  },
  {
    id: 'perf',
    slug: 'performance',
    folder: '性能测试报告',
    label: '性能测试报告',
    defaultPrompt: '性能测试报告提示词.md',
  },
];

/** 新建关联技能时的类型化种子。 */
export const TEST_REPORT_PROMPT_SEEDS: Record<TestReportKind, string> = {
  functional: `# 测试报告整理技能（功能测试）

> 由「报告管理」插件的“功能测试报告”变体关联。日常增删改请到本空间「插件仓库 → 技能」。

## 角色

你负责整理已挂载的功能测试报告，把真实执行事实、缺陷与风险按原模板结构写成可复核的报告。

## 数据口径

1. 只使用当前报告、已关联用例、缺陷记录、测试统计和用户明确提供的材料。
2. 功能报告关注计划用例、执行数、通过 / 失败 / 阻塞、模块覆盖、需求覆盖、缺陷分布和遗留风险。
3. 不得从“未执行”推算为“通过”，不得虚构通过率、缺陷数、版本号、环境或结论。
4. P0 / P1 缺陷和“是否可发布”的最终判断必须由人确认；AI 只能整理证据和建议。

## 写作要求

1. 只改作曲区挂载的报告文件，其它文件不要动。
2. 保留原模板标题层级和章节顺序；缺少模板时使用功能测试报告模板，不要套用接口或性能报告结构。
3. 缺数据时写“待补充”或“未取得”，并说明需要谁补充什么，不得留空冒充已验证。
4. 缺陷分析按模块、严重级别和遗留原因归纳；典型缺陷必须能追溯到真实记录。
5. 改完列出修改章节、新增数据来源和仍待确认项。

## 限制

不要输出与报告无关的闲聊；不要改写成日报、周报、接口测试报告或性能测试报告。`,
  api: `# 测试报告整理技能（接口测试）

> 由「报告管理」插件的“接口测试报告”变体关联。日常增删改请到本空间「插件仓库 → 技能」。

## 角色

你负责整理已挂载的接口测试报告，围绕接口范围、契约断言、执行结果和失败根因形成可复核结论。

## 数据口径

1. 只使用接口用例、自动化结果、接口文档、缺陷记录和用户明确提供的执行数据。
2. 统计接口总数、已覆盖接口数、正反向用例数、执行数、通过 / 失败数和覆盖率。
3. 失败分析必须区分缺陷、环境问题、用例问题和需求变更，不得把所有失败都归为接口缺陷。
4. 不得把功能测试用例结果、计划执行的接口或人工猜测值当作接口实测结果。
5. 低并发 RT 基线只能作为接口回归参考，不得包装成完整性能测试结论。

## 写作要求

1. 只改作曲区挂载的报告文件，其它文件不要动。
2. 保留接口报告模板的章节顺序与表格；没有模板时使用接口测试报告模板。
3. 失败项应写清接口、请求场景、实际现象、断言依据、根因分类和状态；缺陷类必须能关联真实缺陷单号。
4. 缺接口、缺执行结果或缺环境时明确列为覆盖缺口或待补充，不得编造。
5. 改完列出接口覆盖变化、失败分类调整和待确认项。

## 限制

不要输出与报告无关的闲聊；不要套用功能测试报告的缺陷发布结论或性能报告的容量结论。`,
  perf: `# 测试报告整理技能（性能测试）

> 由「报告管理」插件的“性能测试报告”变体关联。日常增删改请到本空间「插件仓库 → 技能」。

## 角色

你负责整理已挂载的性能测试报告，把负载模型、实测指标、资源监控和瓶颈证据形成可复核的容量结论。

## 数据口径

1. 只使用压测工具结果、监控数据、环境配置、脚本场景和用户明确提供的实测数据。
2. 必须记录测试环境、负载模型、业务配比、并发、持续时间、TPS / QPS、P95 / P99 等响应时间分位数和错误率。
3. 指标必须带单位和来源；目标值、基线值与实测值分开记录。
4. 没有实测数据不得估算 TPS、响应时间、错误率或最大容量；不得把单接口低并发基线写成完整压测结论。
5. 环境与生产存在差异时，必须写明差异和是否允许折算；结论由人最终确认。

## 写作要求

1. 只改作曲区挂载的报告文件，其它文件不要动。
2. 保留性能报告模板的章节顺序；没有模板时使用性能测试报告模板。
3. 瓶颈按“现象 → 定位过程 → 根因 → 证据”描述，证据优先使用监控、日志、火焰图或压测原始结果。
4. 调优建议必须区分已验证结论、待验证假设和后续行动，不得把未回归验证的收益写成确定结果。
5. 改完列出指标来源、结论边界和仍待补充的原始数据。

## 限制

不要输出与报告无关的闲聊；不要套用功能发布结论或接口契约报告结构。`,
};

/** 插件开启时补齐三类默认报告技能；已有内容不覆盖。 */
export async function ensureTestReportPromptSkills(): Promise<void> {
  for (const item of TEST_REPORT_KINDS) {
    await ensureMountableSkillSeed(
      item.defaultPrompt,
      TEST_REPORT_PROMPT_SEEDS[item.id],
      'testReports',
    );
  }
}

/** 根据报告相对路径推断所属类型（取第一段目录名） */
export function kindFromReportPath(relPath: string): TestReportKind | null {
  const top = relPath.replace(/\\/g, '/').replace(/^\.\//, '').split('/').filter(Boolean)[0] ?? '';
  const hit = TEST_REPORT_KINDS.find((k) => k.folder === top);
  return hit?.id ?? null;
}

export function kindDef(id: TestReportKind): TestReportKindDef {
  return TEST_REPORT_KINDS.find((k) => k.id === id) ?? TEST_REPORT_KINDS[0]!;
}

export function kindFromSlug(slug: string): TestReportKind | null {
  return TEST_REPORT_KINDS.find((k) => k.slug === slug)?.id ?? null;
}

export const REPORT_FILE_FILTER_VALUES = ['all', 'word', 'excel', 'text', 'csv', 'other'] as const;

export type ReportFileFilter = (typeof REPORT_FILE_FILTER_VALUES)[number];

export function reportFileKind(name: string): Exclude<ReportFileFilter, 'all'> {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  if (ext === 'doc' || ext === 'docx') return 'word';
  if (ext === 'xls' || ext === 'xlsx') return 'excel';
  if (ext === 'md' || ext === 'markdown' || ext === 'txt') return 'text';
  if (ext === 'csv') return 'csv';
  return 'other';
}

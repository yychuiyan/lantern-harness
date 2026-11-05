/**
 * 报告管理：三类归档目录 + 按类型挂载提示词（本机按空间记住）。
 */
import { readActiveSpaceId } from './space-scope';

export type TestReportKind = 'functional' | 'api' | 'perf';

export interface TestReportKindDef {
  id: TestReportKind;
  /** 磁盘子目录名 */
  folder: string;
  label: string;
  /** 开关联种 / 默认挂载的提示词文件名 */
  defaultPrompt: string;
}

export const TEST_REPORT_KINDS: readonly TestReportKindDef[] = [
  {
    id: 'functional',
    folder: '功能测试报告',
    label: '功能测试报告',
    defaultPrompt: '功能测试报告提示词.md',
  },
  {
    id: 'api',
    folder: '接口测试报告',
    label: '接口测试报告',
    defaultPrompt: '接口测试报告提示词.md',
  },
  {
    id: 'perf',
    folder: '性能测试报告',
    label: '性能测试报告',
    defaultPrompt: '性能测试报告提示词.md',
  },
];

/** 新建提示词时的短种子 */
export const TEST_REPORT_PROMPT_SEED = `# 测试报告提示词

> 由「报告管理」插件按报告类型挂载。日常增删改请只改本空间「提示词管理」里的本文件。

## 角色

你协助修改已挂载的测试报告正文，保持原有章节结构与口径。

## 要求

1. 只改作曲区挂载的那份报告文件，其它文件不要动。
2. 保留原有标题层级与章节顺序；缺段再补，不要整篇重写成别的模板。
3. 不要编造未提供的测试数据、结论或通过率；缺信息时标明待补充。
4. 改完说明改了哪些章节。

## 限制

不要输出与报告无关的闲聊；不要擅自改成日报 / 周报口径。
`;

function mountStoreKey(): string {
  const space = readActiveSpaceId();
  return space ? `tw.testReports.promptMounts.v1:${space}` : 'tw.testReports.promptMounts.v1';
}

export type TestReportPromptMounts = Partial<Record<TestReportKind, string>>;

export function loadTestReportPromptMounts(): TestReportPromptMounts {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(mountStoreKey());
    if (!raw) return {};
    const obj = JSON.parse(raw) as TestReportPromptMounts;
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

export function saveTestReportPromptMounts(next: TestReportPromptMounts): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(mountStoreKey(), JSON.stringify(next));
  } catch {
    // ignore
  }
}

export function bindTestReportPrompt(kind: TestReportKind, file: string): TestReportPromptMounts {
  const mounts = { ...loadTestReportPromptMounts() };
  const name = file.trim();
  if (name) mounts[kind] = name;
  else delete mounts[kind];
  saveTestReportPromptMounts(mounts);
  return mounts;
}

export function mountedPromptForKind(kind: TestReportKind): string {
  const mounts = loadTestReportPromptMounts();
  const hit = mounts[kind]?.trim();
  if (hit) return hit;
  return TEST_REPORT_KINDS.find((k) => k.id === kind)?.defaultPrompt ?? '';
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

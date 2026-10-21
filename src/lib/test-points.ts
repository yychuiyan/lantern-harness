/**
 * 生成测试点：类型、提示词接口、分组统计与导出（XMind / Markdown）。
 *
 * 测试点也不单独存一份数据，直接复用「需求分析」文档的 `testPoints` 字段
 * （见 lh-plugins/lh-req-analysis.mjs）。本文件只做「取提示词 / 分组 / 导出」，
 * 生成执行留在工作台组件里。
 */
import { APP_VERSION } from './app-version';
import type { PmTone } from '../components/islands/PmShared';
import type { ReqAnalysisDoc } from './req-analysis';

export const TEST_POINTS_API = '/__tb_testpoints';
/** 与 lh-plugins/plugin-prompts.mjs 保持一致 */
export const TEST_POINTS_PROMPT_FILE = '测试点生成提示词.md';

/** 五个维度：功能 / 边界值 / 异常 / 业务规则 / 非功能 */
export type TestDimension = 'functional' | 'boundary' | 'exception' | 'business' | 'nonfunctional';
export type TestPriority = 'P0' | 'P1' | 'P2' | 'P3';

export interface TestPoint {
  id: string;
  /** 对应故事；跨故事的全局测试点为空串 */
  storyId: string;
  dimension: TestDimension;
  priority: TestPriority;
  title: string;
  precondition: string;
  steps: string[];
  expected: string;
}

export interface TestPointReport {
  at: string;
  summary: string;
  points: TestPoint[];
}

export interface TestPointsPrompt {
  file: string;
  exists: boolean;
  /** `## 生成` 段：拆测试点的 system prompt */
  generate: string;
  error?: string;
}

export interface TestPointsPromptSync {
  ok: boolean;
  enabled: boolean;
  file: string;
  created?: boolean;
  updated?: boolean;
  exists?: boolean;
  removed?: boolean;
}

export const DIMENSION_ORDER: TestDimension[] = [
  'functional',
  'boundary',
  'exception',
  'business',
  'nonfunctional',
];

export const PRIORITY_ORDER: TestPriority[] = ['P0', 'P1', 'P2', 'P3'];

export const DIMENSION_META: Record<
  TestDimension,
  { label: string; hint: string; tone: PmTone; accent: string }
> = {
  functional: {
    label: '功能',
    hint: '主流程 / 替代流程 / 每个功能点',
    tone: 'blue',
    accent: 'bg-[#3370ff]',
  },
  boundary: {
    label: '边界值',
    hint: '为空 / 上下限 / 刚好越界',
    tone: 'purple',
    accent: 'bg-[#7b5bd6]',
  },
  exception: {
    label: '异常',
    hint: '失败路径 / 非法输入 / 并发',
    tone: 'red',
    accent: 'bg-[#e5484d]',
  },
  business: {
    label: '业务规则',
    hint: '状态流转 / 权限 / 唯一性',
    tone: 'amber',
    accent: 'bg-[#d9820b]',
  },
  nonfunctional: {
    label: '非功能',
    hint: '性能 / 安全 / 兼容 / 时区',
    tone: 'green',
    accent: 'bg-[#2f9e44]',
  },
};

export const PRIORITY_META: Record<
  TestPriority,
  { label: string; tone: PmTone; markerId: string }
> = {
  P0: { label: 'P0', tone: 'red', markerId: 'priority-1' },
  P1: { label: 'P1', tone: 'amber', markerId: 'priority-2' },
  P2: { label: 'P2', tone: 'blue', markerId: 'priority-3' },
  P3: { label: 'P3', tone: 'gray', markerId: 'priority-4' },
};

export const DIMENSION_LABEL: Record<TestDimension, string> = Object.fromEntries(
  DIMENSION_ORDER.map((key) => [key, DIMENSION_META[key].label]),
) as Record<TestDimension, string>;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${TEST_POINTS_API}${path}`, {
    ...init,
    headers:
      init?.body === undefined
        ? undefined
        : { 'Content-Type': 'application/json', ...init?.headers },
  });
  const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string } & T;
  if (!res.ok || json.ok === false) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

export async function fetchTestPointsHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${TEST_POINTS_API}?health=1`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

/** 读提示词；读不到时不抛错，把原因放在 `error` 里，生成前拦下来提示 */
export async function fetchTestPointsPrompt(): Promise<TestPointsPrompt> {
  try {
    const json = await request<Omit<TestPointsPrompt, 'file'>>('/prompt');
    return {
      file: TEST_POINTS_PROMPT_FILE,
      exists: json.exists === true,
      generate: json.generate ?? '',
    };
  } catch (err) {
    return {
      file: TEST_POINTS_PROMPT_FILE,
      exists: false,
      generate: '',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** 开关联动：enabled=true 缺提示词就补种子；false 只停用、不删文件 */
export async function syncTestPointsPrompt(enabled: boolean): Promise<TestPointsPromptSync> {
  return request<TestPointsPromptSync>('/prompt/sync', {
    method: 'POST',
    body: JSON.stringify({ enabled }),
  });
}

/* ------------------------------ 分组统计 ------------------------------ */

const PRIORITY_RANK: Record<TestPriority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

export interface TestPointGroup {
  key: TestDimension;
  label: string;
  hint: string;
  points: TestPoint[];
}

/**
 * 按五个维度分组。空维度也返回（导图上要显示「无」），
 * 维度顺序固定，维度内按 P0 → P3、再按标题排序。
 */
export function groupTestPoints(report: TestPointReport | null): TestPointGroup[] {
  const points = report?.points ?? [];
  return DIMENSION_ORDER.map((key) => ({
    key,
    label: DIMENSION_META[key].label,
    hint: DIMENSION_META[key].hint,
    points: points
      .filter((point) => point.dimension === key)
      .sort(
        (a, b) =>
          PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
          a.title.localeCompare(b.title, 'zh'),
      ),
  }));
}

export interface TestPointStats {
  total: number;
  byPriority: Record<TestPriority, number>;
  /** 有测试点的维度数（0–5） */
  coveredDimensions: number;
}

export function countTestPoints(report: TestPointReport | null): TestPointStats {
  const points = report?.points ?? [];
  const byPriority = { P0: 0, P1: 0, P2: 0, P3: 0 } as Record<TestPriority, number>;
  for (const point of points) {
    if (point.priority in byPriority) byPriority[point.priority] += 1;
  }
  return {
    total: points.length,
    byPriority,
    coveredDimensions: DIMENSION_ORDER.filter((key) =>
      points.some((point) => point.dimension === key),
    ).length,
  };
}

/** 维度顺序 + P0 优先的扁平列表，导出与导图共用同一个顺序 */
export function sortTestPoints(points: readonly TestPoint[]): TestPoint[] {
  return [...points].sort(
    (a, b) =>
      DIMENSION_ORDER.indexOf(a.dimension) - DIMENSION_ORDER.indexOf(b.dimension) ||
      PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
      a.title.localeCompare(b.title, 'zh'),
  );
}

/**
 * 生成用例时注入的测试点上下文：只列选中的点，按维度分组、组内 P0 优先。
 * 与导出 Markdown 的区别：不写空维度，也不带文档标题与统计。
 */
export function testPointsToPromptBlock(points: readonly TestPoint[]): string {
  const picked = sortTestPoints(points);
  if (!picked.length) return '';
  const lines: string[] = [];
  for (const dim of DIMENSION_ORDER) {
    const group = picked.filter((point) => point.dimension === dim);
    if (!group.length) continue;
    lines.push(`#### ${DIMENSION_META[dim].label}`);
    for (const point of group) {
      lines.push(`- **[${point.priority}]** ${point.title}（${point.id}）`);
      if (point.storyId) lines.push(`  - 来源故事：${point.storyId}`);
      if (point.precondition) lines.push(`  - 前置：${point.precondition}`);
      if (point.steps.length) lines.push(`  - 步骤：${point.steps.join('；')}`);
      if (point.expected) lines.push(`  - 预期：${point.expected}`);
    }
  }
  return lines.join('\n');
}

/* ------------------------------ XMind ------------------------------ */

interface XMindTopic {
  id: string;
  title: string;
  /** 骨架类型：逻辑图（向右的树） */
  structureClass?: string;
  labels?: string[];
  markers?: { markerId: string }[];
  notes?: { plain: { content: string } };
  children?: { attached: XMindTopic[] };
}

/** 导出用的安全文件名：去掉路径分隔符与日期后缀 */
function safeName(title: string): string {
  return (title || '需求分析').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
}

function pointNotes(point: TestPoint): string {
  const lines: string[] = [];
  if (point.precondition) lines.push(`前置条件：${point.precondition}`);
  if (point.steps.length) {
    lines.push('步骤：');
    point.steps.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
  }
  if (point.expected) lines.push(`预期：${point.expected}`);
  return lines.join('\n');
}

function topicId(prefix: string, key: string): string {
  const clean = key.replace(/[^A-Za-z0-9_-]/g, '');
  return clean ? `${prefix}-${clean}` : `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 一条测试点 → XMind 叶子节点（标题带优先级，标签带维度，备注带前置 / 步骤 / 预期） */
function pointTopic(point: TestPoint): XMindTopic {
  return {
    id: topicId('tp', point.id),
    title: `[${point.priority}] ${point.title}`,
    labels: [DIMENSION_META[point.dimension].label, point.priority],
    markers: [{ markerId: PRIORITY_META[point.priority].markerId }],
    notes: { plain: { content: pointNotes(point) } },
  };
}

/**
 * 按「功能」归组：一个用户故事（功能点）下的全部测试点挂在一起。
 *
 * 顺序跟文档里的故事一致；没有归属（storyId 为空）或引用了已删故事的点统一落到
 * 末尾的「全局测试点」分支，保证导出不丢点。组内按 P0 → P3、再按维度排序。
 */
export function groupTestPointsByStory(doc: ReqAnalysisDoc): {
  key: string;
  label: string;
  points: TestPoint[];
}[] {
  const points = doc.testPoints?.points ?? [];
  const storyIds = doc.stories.map((story) => story.id);
  const storyTitle = new Map(doc.stories.map((story) => [story.id, story.title]));
  const buckets = new Map<string, TestPoint[]>();

  for (const point of points) {
    // 未知 storyId 也保留为一条分支（老数据里故事被删过），不并进「全局」
    const key = point.storyId || '';
    const list = buckets.get(key);
    if (list) list.push(point);
    else buckets.set(key, [point]);
  }

  const order = [
    ...storyIds,
    ...[...buckets.keys()].filter((key) => key && !storyIds.includes(key)).sort(),
    '',
  ];
  const groups: { key: string; label: string; points: TestPoint[] }[] = [];
  for (const key of order) {
    const list = buckets.get(key);
    if (!list?.length) continue;
    const title = key ? storyTitle.get(key) : '';
    groups.push({
      key: key || 'global',
      label: key ? `${key} ${title ?? ''}`.trim() : '全局测试点',
      points: [...list].sort(
        (a, b) =>
          PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
          DIMENSION_ORDER.indexOf(a.dimension) - DIMENSION_ORDER.indexOf(b.dimension) ||
          a.title.localeCompare(b.title, 'zh'),
      ),
    });
  }
  return groups;
}

/**
 * 生成 XMind 的 `content.json` 结构：
 * 根节点 = 分析标题（逻辑图骨架），一级子节点 = 功能 / 用户故事，二级子节点 = 对应测试点。
 * 纯函数，便于单测结构。
 */
export function buildXMindContent(doc: ReqAnalysisDoc): unknown[] {
  const report = doc.testPoints;
  const featureTopics: XMindTopic[] = groupTestPointsByStory(doc).map((group) => {
    const dims = DIMENSION_ORDER.map(
      (dim) => group.points.filter((p) => p.dimension === dim).length,
    );
    const covered = dims.filter((n) => n > 0).length;
    return {
      id: topicId('fn', group.key),
      title: `${group.label}（${group.points.length}）`,
      notes: {
        plain: {
          content: `测试点 ${group.points.length} 条 · 维度覆盖 ${covered}/5\n${DIMENSION_ORDER.map(
            (dim, i) => `${DIMENSION_META[dim].label} ${dims[i]}`,
          ).join(' · ')}`,
        },
      },
      children: { attached: group.points.map(pointTopic) },
    };
  });
  const rootTopic: XMindTopic = {
    id: 'root-topic',
    title: `测试点 · ${doc.title || '未命名分析'}`,
    // 逻辑图（向右展开的树）：功能 → 测试点，比发散式导图更贴合「按功能核对」的读法
    structureClass: 'org.xmind.ui.logic.right',
    notes: {
      plain: {
        content: report?.summary
          ? report.summary
          : '按功能 / 用户故事归组的测试点，叶子标注优先级与所属维度。',
      },
    },
    children: { attached: featureTopics },
  };
  return [
    {
      id: 'sheet-1',
      class: 'sheet',
      title: doc.title || '测试点',
      rootTopic,
    },
  ];
}

/** 打包成浏览器可直接下载的 .xmind（zip + content.json / metadata.json / manifest.json） */
export async function buildXMindBlob(doc: ReqAnalysisDoc): Promise<Blob> {
  const content = buildXMindContent(doc);
  // 动态引入：只有真的点导出时才加载打包库，普通页面不为它买单
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  zip.file('content.json', JSON.stringify(content));
  zip.file(
    'metadata.json',
    JSON.stringify({
      creator: { name: 'Lantern Harness', version: APP_VERSION },
      activeSheetId: 'sheet-1',
    }),
  );
  zip.file(
    'manifest.json',
    JSON.stringify({ 'file-entries': { 'content.json': {}, 'metadata.json': {} } }),
  );
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
}

/** 下载 .xmind；文件名带上分析标题与日期，多次导出不互相覆盖 */
export async function downloadTestPointsXMind(doc: ReqAnalysisDoc): Promise<string> {
  const day = new Date().toISOString().slice(0, 10);
  const name = `${safeName(doc.title)}-测试点-${day}.xmind`;
  const blob = await buildXMindBlob(doc);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
  return name;
}

/* ------------------------------ Markdown ------------------------------ */

/**
 * 导出 Markdown 大纲：按功能（用户故事）分节，与 XMind 导出口径一致。
 * 维度不再单独分节，而是标在每条测试点后面，这样「一个功能有哪些点、覆盖了哪几维」能一起看。
 */
export function testPointsToMarkdown(doc: ReqAnalysisDoc): string {
  const report = doc.testPoints;
  const lines: string[] = [];
  lines.push(`# 测试点 · ${doc.title || '未命名分析'}`);
  lines.push('');
  lines.push(`> 来源：\`${doc.sourcePath || '（未指定）'}\` · 故事 ${doc.stories.length} 条`);
  lines.push('');
  if (!report) {
    lines.push('- 还没有生成测试点。');
    return `${lines.join('\n')}\n`;
  }
  const stats = countTestPoints(report);
  lines.push(`- 生成时间：${report.at}`);
  lines.push(
    `- 共 ${stats.total} 条（P0 ${stats.byPriority.P0} / P1 ${stats.byPriority.P1} / P2 ${stats.byPriority.P2} / P3 ${stats.byPriority.P3}）`,
  );
  lines.push(`- 维度覆盖：${stats.coveredDimensions}/5`);
  if (report.summary) {
    lines.push('');
    lines.push(report.summary);
  }
  lines.push('');
  const groups = groupTestPointsByStory(doc);
  if (!groups.length) {
    lines.push('- 还没有生成测试点。');
    return `${lines.join('\n').trimEnd()}\n`;
  }
  for (const group of groups) {
    lines.push(`## ${group.label}（${group.points.length}）`);
    lines.push('');
    for (const point of group.points) {
      lines.push(
        `- **[${point.priority}]** ${point.title} · ${DIMENSION_META[point.dimension].label}`,
      );
      if (point.precondition) lines.push(`  - 前置：${point.precondition}`);
      if (point.steps.length) lines.push(`  - 步骤：${point.steps.join('；')}`);
      if (point.expected) lines.push(`  - 预期：${point.expected}`);
    }
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/** 下载 Markdown 大纲；文件名对齐 XMind 导出口径 */
export function downloadTestPointsMarkdown(doc: ReqAnalysisDoc): string {
  const day = new Date().toISOString().slice(0, 10);
  const name = `${safeName(doc.title)}-测试点-${day}.md`;
  const blob = new Blob([testPointsToMarkdown(doc)], {
    type: 'text/markdown;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
  return name;
}

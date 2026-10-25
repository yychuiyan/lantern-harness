/**
 * 生成测试点：类型、提示词接口、分组统计与导出（XMind / Markdown）。
 *
 * 测试点也不单独存一份数据，直接复用「需求分析」文档的 `testPoints` 字段
 * （见 lh-plugins/lh-req-analysis.mjs）。本文件只做「取提示词 / 分组 / 导出」，
 * 生成执行留在工作台组件里。
 */
import { APP_VERSION } from './app-version';
import type { PmTone } from '../components/islands/PmShared';
import { reqSourceFileName, type ReqAnalysisDoc, type ReqStory } from './req-analysis';

/** 导出 / 导图根节点用的需求名称：正文标题优先，不回落到带扩展名的文件名 */
/** 需求文档名称：来源文件名（不是 Ideal 大模块名） */
function reqDisplayTitle(doc: ReqAnalysisDoc): string {
  return reqSourceFileName(doc);
}

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
  /** 补充扩展点（正式覆盖之后）；落到用例备注「补充：」 */
  supplemental?: boolean;
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

/** 正式在前 → 维度 → P0 优先；导出与导图共用 */
export function sortTestPoints(points: readonly TestPoint[]): TestPoint[] {
  return [...points].sort(
    (a, b) =>
      Number(Boolean(a.supplemental)) - Number(Boolean(b.supplemental)) ||
      DIMENSION_ORDER.indexOf(a.dimension) - DIMENSION_ORDER.indexOf(b.dimension) ||
      PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
      a.title.localeCompare(b.title, 'zh'),
  );
}

/**
 * 生成用例时注入的测试点上下文。
 * 顺序跟需求/用户故事走：先按 `storyOrder`（分析里的故事顺序），组内保持传入顺序；
 * 不再按维度 / 优先级重排，否则模型写出的用例会和需求文档对不上。
 */
export function testPointsToPromptBlock(
  points: readonly TestPoint[],
  storyOrder: readonly string[] = [],
): string {
  if (!points.length) return '';
  const ordered = orderTestPointsForCaseGen(points, storyOrder);
  const lines: string[] = [];
  let lastStory = '\u0000';
  for (const point of ordered) {
    const storyKey = point.storyId || '';
    if (storyKey !== lastStory) {
      lastStory = storyKey;
      lines.push(storyKey ? `#### ${storyKey}` : '#### 全局测试点');
    }
    lines.push(`- **[${point.priority}]** ${point.title}（${point.id}）`);
    if (point.storyId) lines.push(`  - 来源故事：${point.storyId}`);
    lines.push(`  - 维度：${DIMENSION_META[point.dimension].label}`);
    if (point.precondition) lines.push(`  - 前置：${point.precondition}`);
    if (point.steps.length) lines.push(`  - 步骤：${point.steps.join('；')}`);
    if (point.expected) lines.push(`  - 预期：${point.expected}`);
  }
  return lines.join('\n');
}

/** 用例生成用：故事顺序优先，同故事内保持传入列表顺序 */
export function orderTestPointsForCaseGen(
  points: readonly TestPoint[],
  storyOrder: readonly string[] = [],
): TestPoint[] {
  if (!points.length) return [];
  if (!storyOrder.length) return [...points];
  const rank = new Map(storyOrder.map((id, i) => [id, i]));
  return points
    .map((point, index) => ({ point, index }))
    .sort((a, b) => {
      const ra = a.point.storyId
        ? (rank.get(a.point.storyId) ?? storyOrder.length + 1)
        : storyOrder.length;
      const rb = b.point.storyId
        ? (rank.get(b.point.storyId) ?? storyOrder.length + 1)
        : storyOrder.length;
      return ra - rb || a.index - b.index;
    })
    .map((x) => x.point);
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

/**
 * XMind 节点 id 必须在整本 workbook 内唯一。
 * 需求标题多为中文，若直接 strip 非 ASCII，各 sheet 的「功能/边界值…」会撞成同一个
 * `dim-functional`，XMind 打开时报「无效数据或已损坏」。
 */
function topicId(prefix: string, key: string): string {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const h = (hash >>> 0).toString(36);
  const clean = key.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24);
  return clean ? `${prefix}-${clean}-${h}` : `${prefix}-${h}`;
}

/** 一条测试点 → XMind 叶子（图2：标题带 [P#]，标签挂维度名，marker 标优先级） */
function pointTopic(point: TestPoint): XMindTopic {
  return {
    id: topicId('tp', point.id),
    title: `[${point.priority}] ${point.title}`,
    labels: [DIMENSION_META[point.dimension].label],
    markers: [{ markerId: PRIORITY_META[point.priority].markerId }],
    notes: { plain: { content: pointNotes(point) } },
  };
}

/**
 * 按「用户故事」扁平归组（不含五维）：用例生成仍用。
 * 顺序跟文档里的故事一致；无归属点落到末尾「全局测试点」。
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
      points: sortTestPoints(list),
    });
  }
  return groups;
}

export interface TestPointRequirementGroup {
  key: string;
  /** Ideal 行整理出的需求标题 */
  title: string;
  /** 归到该需求下的故事 id */
  storyIds: string[];
  points: TestPoint[];
  /** 该需求下的五维（空维也保留） */
  dimensions: TestPointGroup[];
}

/** Ideal 行标题匹配用的软关键词（更具体的在前；优先于大纲字串包含） */
const IDEAL_TITLE_HINTS: Array<{ re: RegExp; title: string }> = [
  { re: /ai\s*拆解|推送ai|回写拆解/i, title: 'ai拆解' },
  { re: /ai自动同步|知识信息列表.*开关|知识信息管理/i, title: '知识信息管理' },
  { re: /信息审核|审核倒计时|出具审核结论|待审核信息/i, title: '政企通信息审核' },
  { re: /信息确认|确认无误|待确认信息/i, title: '政企通信息确认' },
  { re: /开通确认|确认开通/i, title: '政企通开通确认' },
  {
    re: /信息管理列表|承办单位修改|查看详情|政企通路径|关联信息标题/i,
    title: '政企通信息管理',
  },
  {
    re: /页面管理|页面树|节点|前台预览|本级节点布局|暂存|发给承办|信息列表|展示类型/i,
    title: '政企通页面管理',
  },
  { re: /菜单|子菜单|文案本地化|时间展示/i, title: '政企通' },
];

function resolveIdealHint(hintTitle: string, ranked: string[]): string | null {
  const exact = ranked.find((t) => t === hintTitle);
  if (exact) return exact;
  // 避免「政企通」误匹配到「政企通页面管理」：仅当 hint 更长时才用包含关系
  return (
    ranked.find((t) => hintTitle.length >= t.length && hintTitle.includes(t)) ||
    ranked.find((t) => t.length > hintTitle.length && t.includes(hintTitle)) ||
    null
  );
}

/**
 * 把一条用户故事归到 Ideal 需求标题（一行一条）。
 * 优先软关键词（故事语义），再故事标题包含，再大纲包含。
 */
export function matchStoryToIdealTitle(
  story: ReqStory,
  outlineTitles: Map<string, string>,
  idealTitles: string[],
): string {
  if (!idealTitles.length) return story.title || story.id;

  const storyBlob = story.title || '';
  const outlineBlob = story.sourceRefs.map((id) => outlineTitles.get(id) || id).join(' ');
  const blob = `${storyBlob} ${outlineBlob}`;
  const ranked = [...idealTitles].sort((a, b) => b.length - a.length || a.localeCompare(b, 'zh'));

  for (const hint of IDEAL_TITLE_HINTS) {
    if (!hint.re.test(blob)) continue;
    const hit = resolveIdealHint(hint.title, ranked);
    if (hit) return hit;
  }
  for (const title of ranked) {
    if (title && storyBlob.includes(title)) return title;
  }
  for (const title of ranked) {
    if (title && blob.includes(title)) return title;
  }
  return story.title || story.id;
}

function buildDimensionGroups(points: TestPoint[]): TestPointGroup[] {
  const sorted = sortTestPoints(points);
  return DIMENSION_ORDER.map((key) => ({
    key,
    label: DIMENSION_META[key].label,
    hint: DIMENSION_META[key].hint,
    points: sorted.filter((point) => point.dimension === key),
  }));
}

/**
 * 展示 / 导出主口径：Ideal 需求标题（一行一条）→ 五维 → 测试点。
 *
 * @param idealTitles 来自需求正文 `extractIdealRequirementTitles`；缺省时退回按故事标题分
 */
export function groupTestPointsByRequirement(
  doc: ReqAnalysisDoc,
  idealTitles: string[] = [],
): TestPointRequirementGroup[] {
  const points = doc.testPoints?.points ?? [];
  if (!points.length) return [];

  const outlineTitles = new Map(doc.outline.map((item) => [item.id, item.title]));
  const storiesById = new Map(doc.stories.map((story) => [story.id, story]));
  const titles = idealTitles.filter(Boolean);

  const buckets = new Map<string, { title: string; storyIds: Set<string>; points: TestPoint[] }>();
  const ensure = (title: string) => {
    let bucket = buckets.get(title);
    if (!bucket) {
      bucket = { title, storyIds: new Set(), points: [] };
      buckets.set(title, bucket);
    }
    return bucket;
  };

  // 先按 Ideal 行序占位，保证与需求表一致（无测试点的行也保留空壳）
  for (const title of titles) ensure(title);

  for (const point of points) {
    const story = point.storyId ? storiesById.get(point.storyId) : undefined;
    let title: string;
    if (story && titles.length) {
      title = matchStoryToIdealTitle(story, outlineTitles, titles);
    } else if (story) {
      title = story.title || story.id;
    } else {
      title = '全局测试点';
    }
    const bucket = ensure(title);
    bucket.points.push(point);
    if (point.storyId) bucket.storyIds.add(point.storyId);
  }

  const order = [
    ...titles,
    ...[...buckets.keys()].filter((t) => !titles.includes(t) && t !== '全局测试点'),
    ...(buckets.has('全局测试点') ? ['全局测试点'] : []),
  ];
  const seen = new Set<string>();
  const groups: TestPointRequirementGroup[] = [];
  for (const title of order) {
    if (seen.has(title)) continue;
    seen.add(title);
    const bucket = buckets.get(title);
    if (!bucket) continue;
    // Ideal 目录里的行即使暂无测试点也展示；额外冒出来的标题无点则跳过
    if (!bucket.points.length && !titles.includes(title)) continue;
    groups.push({
      key: title,
      title,
      storyIds: [...bucket.storyIds],
      points: sortTestPoints(bucket.points),
      dimensions: buildDimensionGroups(bucket.points),
    });
  }
  return groups;
}

/**
 * 整本画布骨架：向右逻辑图（图2）。
 * 仅一条 Ideal 需求时：根 = 需求标题（N）→ 五维 → 测试点（与 Ideal 导出一致）。
 * 多条时：根 = 文档名 → 各 Ideal 需求（N）→ 五维 → 测试点。
 */
export const XMIND_REQ_STRUCTURE = 'org.xmind.ui.logic.right';

function dimensionTopics(
  reqKey: string,
  dimensions: TestPointRequirementGroup['dimensions'],
): XMindTopic[] {
  return dimensions.map((dim) => ({
    id: topicId('dim', `${reqKey}:${dim.key}`),
    title: `${dim.label}（${dim.points.length}）`,
    notes: {
      plain: {
        content: `${DIMENSION_META[dim.key].hint}\n测试点 ${dim.points.length} 条`,
      },
    },
    children: { attached: dim.points.map(pointTopic) },
  }));
}

function requirementTopic(req: TestPointRequirementGroup): XMindTopic {
  return {
    id: topicId('req', req.key),
    title: `${req.title}（${req.points.length}）`,
    notes: {
      plain: {
        content: [
          req.storyIds.length ? `来源故事：${req.storyIds.join('、')}` : '',
          `测试点 ${req.points.length} 条`,
        ]
          .filter(Boolean)
          .join('\n'),
      },
    },
    children: { attached: dimensionTopics(req.key, req.dimensions) },
  };
}

/**
 * 生成 XMind（单画布，图2 口径）。
 * - 只有一条需求分组时：根直接是「政企通（7）」→ 五维 → 点（与 Ideal 单条导出一致）
 * - 多条时：根是文档名，一级挂各 Ideal 需求（N），其下再五维 → 点
 */
export function buildXMindContent(doc: ReqAnalysisDoc, idealTitles: string[] = []): unknown[] {
  const report = doc.testPoints;
  const groups = groupTestPointsByRequirement(doc, idealTitles).filter(
    (req) => req.points.length > 0,
  );
  const docTitle = reqDisplayTitle(doc);

  if (!groups.length) {
    return [
      {
        id: 'sheet-1',
        class: 'sheet',
        title: docTitle,
        rootTopic: {
          id: 'root-topic',
          title: `${docTitle}（0）`,
          structureClass: XMIND_REQ_STRUCTURE,
          notes: {
            plain: {
              content: report?.summary || '还没有测试点。',
            },
          },
          children: {
            attached: DIMENSION_ORDER.map((key) => ({
              id: topicId('dim', key),
              title: `${DIMENSION_META[key].label}（0）`,
              notes: {
                plain: { content: `${DIMENSION_META[key].hint}\n测试点 0 条` },
              },
              children: { attached: [] as XMindTopic[] },
            })),
          },
        },
      },
    ];
  }

  // 图2：单条 Ideal 需求时根就是「标题（N）」→ 五维
  if (groups.length === 1) {
    const req = groups[0]!;
    return [
      {
        id: 'sheet-1',
        class: 'sheet',
        title: req.title,
        rootTopic: {
          id: topicId('root', req.key),
          title: `${req.title}（${req.points.length}）`,
          structureClass: XMIND_REQ_STRUCTURE,
          notes: {
            plain: {
              content: [
                report?.summary || '',
                req.storyIds.length ? `来源故事：${req.storyIds.join('、')}` : '',
                `测试点 ${req.points.length} 条`,
              ]
                .filter(Boolean)
                .join('\n'),
            },
          },
          children: { attached: dimensionTopics(req.key, req.dimensions) },
        },
      },
    ];
  }

  const total = groups.reduce((sum, req) => sum + req.points.length, 0);
  return [
    {
      id: 'sheet-1',
      class: 'sheet',
      title: docTitle,
      rootTopic: {
        id: 'root-topic',
        title: docTitle,
        structureClass: XMIND_REQ_STRUCTURE,
        notes: {
          plain: {
            content: [report?.summary || '', `测试点 ${total} 条`].filter(Boolean).join('\n'),
          },
        },
        children: { attached: groups.map(requirementTopic) },
      },
    },
  ];
}

/** 打包成浏览器可直接下载的 .xmind（zip + content.json / metadata.json / manifest.json） */
export async function buildXMindBlob(
  doc: ReqAnalysisDoc,
  idealTitles: string[] = [],
): Promise<Blob> {
  const content = buildXMindContent(doc, idealTitles);
  // 动态引入：只有真的点导出时才加载打包库，普通页面不为它买单
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  zip.file('content.json', JSON.stringify(content));
  const sheets = Array.isArray(content) ? content : [];
  const activeSheetId =
    (sheets[0] && typeof sheets[0] === 'object' && (sheets[0] as { id?: string }).id) || 'sheet-1';
  zip.file(
    'metadata.json',
    JSON.stringify({
      creator: { name: 'Lantern Harness', version: APP_VERSION },
      activeSheetId,
    }),
  );
  zip.file(
    'manifest.json',
    JSON.stringify({ 'file-entries': { 'content.json': {}, 'metadata.json': {} } }),
  );
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
}

/** 下载 .xmind；文件名带上分析标题与日期，多次导出不互相覆盖 */
export async function downloadTestPointsXMind(
  doc: ReqAnalysisDoc,
  idealTitles: string[] = [],
): Promise<string> {
  const day = new Date().toISOString().slice(0, 10);
  const name = `${safeName(reqDisplayTitle(doc))}-测试点-${day}.xmind`;
  const blob = await buildXMindBlob(doc, idealTitles);
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
 * 导出 Markdown 大纲：文档名 → Ideal 需求标题 → 五维，与界面 / XMind 口径一致。
 */
export function testPointsToMarkdown(doc: ReqAnalysisDoc, idealTitles: string[] = []): string {
  const report = doc.testPoints;
  const docTitle = reqDisplayTitle(doc);
  const lines: string[] = [];
  lines.push(`# ${docTitle}`);
  lines.push('');
  const reqGroups = groupTestPointsByRequirement(doc, idealTitles);
  lines.push(
    `> 需求测试点 · 来源：\`${doc.sourcePath || '（未指定）'}\` · 需求 ${reqGroups.length || doc.stories.length} 条 · 测试点 ${report?.points.length ?? 0} 条`,
  );
  lines.push('');
  if (!report?.points.length) {
    lines.push('- 还没有生成测试点。');
    return `${lines.join('\n').trimEnd()}\n`;
  }
  const stats = countTestPoints(report);
  lines.push(`- 生成时间：${report.at}`);
  lines.push(
    `- 共 ${stats.total} 条（P0 ${stats.byPriority.P0} / P1 ${stats.byPriority.P1} / P2 ${stats.byPriority.P2} / P3 ${stats.byPriority.P3}）`,
  );
  lines.push(`- 需求 ${reqGroups.length} 条 · 维度覆盖 ${stats.coveredDimensions}/5`);
  if (report.summary) {
    lines.push('');
    lines.push(report.summary);
  }
  lines.push('');
  for (const req of reqGroups) {
    lines.push(`## ${req.title} · ${req.points.length} 条`);
    lines.push('');
    for (const dim of req.dimensions) {
      lines.push(`### ${dim.label}（${dim.points.length}）`);
      lines.push('');
      if (!dim.points.length) {
        lines.push('- （无）');
        lines.push('');
        continue;
      }
      for (const point of dim.points) {
        lines.push(`- **[${point.priority}]** ${point.title}`);
        if (point.precondition) lines.push(`  - 前置：${point.precondition}`);
        if (point.steps.length) lines.push(`  - 步骤：${point.steps.join('；')}`);
        if (point.expected) lines.push(`  - 预期：${point.expected}`);
      }
      lines.push('');
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/** 下载 Markdown 大纲；文件名对齐 XMind 导出口径 */
export function downloadTestPointsMarkdown(
  doc: ReqAnalysisDoc,
  idealTitles: string[] = [],
): string {
  const day = new Date().toISOString().slice(0, 10);
  const name = `${safeName(reqDisplayTitle(doc))}-测试点-${day}.md`;
  const blob = new Blob([testPointsToMarkdown(doc, idealTitles)], {
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

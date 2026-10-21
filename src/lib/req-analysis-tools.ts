/**
 * 需求分析：给模型用的工具定义与执行器。
 *
 * 模型在浏览器里跑（`streamChatWithTools`），工具调用通过 HTTP 落到
 * lh-plugins/lh-req-analysis.mjs。返回给模型的只是短摘要 + 结构化计数，
 * 不回传整份故事集，避免下一轮上下文被撑爆。
 *
 * 工具优先：拆解 / 补写必须走 `req_set_stories`；跑完没拿到结构化提交时，
 * 调用方用 `parseStoriesFallback` 从回答里的 ```json 代码块兜底解析。
 */
import type { ToolDef } from './llm';
import {
  auditStories,
  gapId,
  mergeCheckGaps,
  mergeStories,
  type ReqAnalysisDoc,
  type ReqCheckReport,
  type ReqGap,
  type ReqGapSeverity,
  type ReqGapType,
  type ReqOutlineItem,
  type ReqStory,
  type ReqStoryDraft,
} from './req-analysis';

export interface ReqToolContext {
  /** 当前文档快照：每次工具调用前由调用方刷新（含上一次工具落盘的结果） */
  getDoc: () => ReqAnalysisDoc | null;
  /** 本批序号（0 起）：需求条目 id 按批次前缀，避免分批拆解时撞号 */
  batch: number;
  /** 保存合并后的需求条目，返回落盘后的结果 */
  saveOutline: (items: ReqOutlineItem[]) => Promise<ReqOutlineItem[]>;
  /** 保存合并后的故事集（服务端按 seq 分配 id） */
  saveStories: (stories: ReqStoryDraft[]) => Promise<ReqAnalysisDoc>;
  /** 保存体检报告 */
  saveCheck: (report: ReqCheckReport) => Promise<ReqAnalysisDoc>;
}

/** 拼进 system prompt：让模型知道这一轮只用哪几个工具、提交完要做什么 */
export const REQ_TOOL_GUIDE = `可用工具（只调用这些，不要自己编工具名）：
- req_set_outline：提交本批「需求条目」，返回每个条目的 id。
- req_set_stories：提交「用户故事」；补写时提交合并后的完整故事集（带原 id 原地更新）。
- req_save_check：提交体检结果（缺口清单 + 结论）。

提交后不要重复提交同样的内容；工具返回 ok 之后再写最终回答。`;

const MODEL_GAP_TYPES: ReqGapType[] = [
  'missing-scenario',
  'missing-dimension',
  'untestable-acceptance',
  'conflict',
  'over-split',
  'other',
];

function asObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function str(value: unknown, max = 500): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function keyOf(value: string): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function severityOf(value: unknown): ReqGapSeverity {
  const v = str(value, 10);
  return v === 'high' || v === 'medium' || v === 'low' ? v : 'medium';
}

function typeOf(value: unknown): ReqGapType {
  const v = str(value, 40) as ReqGapType;
  return MODEL_GAP_TYPES.includes(v) ? v : 'other';
}

/* ------------------------------ 工具定义 ------------------------------ */

const storyProperties = {
  title: { type: 'string', description: '一句话说明这条故事做什么' },
  role: { type: 'string', description: '角色（来自原文；推断的要在 value 里注明）' },
  goal: { type: 'string', description: '用户想达成的目标' },
  value: { type: 'string', description: '业务价值 / 补充说明（角色为推断时写在这里）' },
  sourceRefs: {
    type: 'array',
    items: { type: 'string' },
    description: '对应的需求条目 id（req_set_outline 返回的真实 id）',
  },
  priority: { type: 'string', enum: ['P0', 'P1', 'P2'] },
  preconditions: { type: 'array', items: { type: 'string' } },
  mainFlow: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        actor: { type: 'string' },
        action: { type: 'string', description: '动词开头的一步' },
        result: { type: 'string', description: '用户能看到的变化' },
      },
      required: ['action'],
    },
  },
  altFlows: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        trigger: { type: 'string', description: '什么情况下走这条替代路径' },
        steps: { type: 'array', items: { type: 'string' } },
      },
      required: ['name', 'trigger'],
    },
  },
  exceptions: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        scenario: { type: 'string', description: '异常场景' },
        expected: { type: 'string', description: '系统应有的表现' },
      },
      required: ['scenario', 'expected'],
    },
  },
  postconditions: { type: 'array', items: { type: 'string' } },
  acceptance: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        given: { type: 'string' },
        when: { type: 'string' },
        then: { type: 'string', description: '必须可判定' },
      },
      required: ['given', 'when', 'then'],
    },
  },
  dimensions: {
    type: 'array',
    items: { type: 'string' },
    description: '权限 / 边界值 / 并发与幂等 / 空数据 / 超时与失败 / 国际化与时区',
  },
} as const;

export const REQ_ANALYSIS_TOOLS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'req_set_outline',
      description:
        '提交本批从原始需求里抽出的需求条目（一条 = 一个可独立验收的能力点）。返回每个条目的 id，供 sourceRefs 引用。',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: '一句话概括' },
                quote: { type: 'string', description: '原文关键句，不超过 80 字' },
              },
              required: ['title'],
            },
          },
        },
        required: ['items'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'req_set_stories',
      description:
        '提交用户故事。拆解时只提交这一批新故事；补写时提交合并后的完整故事集（带原 id 的原地更新，新故事不带 id）。',
      parameters: {
        type: 'object',
        properties: {
          stories: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: '已有故事才带（US-001 这种）' },
                ...storyProperties,
              },
              required: ['title', 'role', 'mainFlow', 'acceptance'],
            },
          },
        },
        required: ['stories'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'req_save_check',
      description: '提交需求体检结果：语义类缺口清单 + 两三句话结论。只出问题，不改写故事。',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: '整体结论，两三句话' },
          gaps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                storyTitle: { type: 'string', description: '相关故事标题；全局问题填空串' },
                type: {
                  type: 'string',
                  enum: MODEL_GAP_TYPES,
                },
                severity: { type: 'string', enum: ['high', 'medium', 'low'] },
                title: { type: 'string' },
                detail: { type: 'string', description: '位置 + 原因' },
                suggestion: { type: 'string', description: '建议补写什么' },
              },
              required: ['title', 'detail'],
            },
          },
        },
        required: ['gaps'],
      },
    },
  },
];

/* ------------------------------ 执行 ------------------------------ */

export async function runReqAnalysisTool(
  name: string,
  argsJson: string,
  ctx: ReqToolContext,
): Promise<string> {
  const args = asObject(argsJson);
  const doc = ctx.getDoc();
  if (!doc) return JSON.stringify({ ok: false, error: '当前还没有打开分析文档' });

  if (name === 'req_set_outline') {
    const rawItems = Array.isArray(args.items) ? args.items : [];
    if (!rawItems.length) {
      return JSON.stringify({
        ok: true,
        added: 0,
        total: doc.outline.length,
        items: doc.outline.map(({ id, title }) => ({ id, title })),
        note: '没有提交新条目，需求条目保持不变。',
      });
    }
    const existing = doc.outline;
    const known = new Set(existing.map((item) => keyOf(item.title)));
    const taken = new Set(existing.map((item) => item.id));
    const additions: ReqOutlineItem[] = [];
    for (const raw of rawItems) {
      const item = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      const title = str(item.title, 200) || str(item.quote, 200);
      if (!title || known.has(keyOf(title))) continue;
      known.add(keyOf(title));
      const base = `RO-${ctx.batch + 1}-${additions.length + 1}`;
      let id = base;
      let suffix = 1;
      while (taken.has(id)) id = `${base}-${suffix++}`;
      taken.add(id);
      additions.push({ id, title, quote: str(item.quote, 500) });
    }
    const merged = [...existing, ...additions];
    const saved = await ctx.saveOutline(merged);
    return JSON.stringify({
      ok: true,
      added: additions.length,
      total: saved.length,
      items: saved.map(({ id, title }) => ({ id, title })),
      note:
        additions.length > 0
          ? '条目已保存。接下来用 req_set_stories 提交故事，sourceRefs 只能引用上面返回的 id。'
          : '这些条目已经存在，没有重复写入；继续提交故事即可。',
    });
  }

  if (name === 'req_set_stories') {
    const rawStories = Array.isArray(args.stories) ? args.stories : [];
    if (!rawStories.length) {
      return JSON.stringify({
        ok: true,
        added: 0,
        total: doc.stories.length,
        note: '没有提交故事，故事集保持不变。',
      });
    }
    const before = doc.stories.length;
    const merged = mergeStories(doc.stories, rawStories);
    const saved = await ctx.saveStories(merged);
    const known = new Set(doc.outline.map((item) => item.id));
    const dangling = saved.stories
      .flatMap((story) => story.sourceRefs)
      .filter((ref) => !known.has(ref));
    return JSON.stringify({
      ok: true,
      added: Math.max(0, saved.stories.length - before),
      total: saved.stories.length,
      stories: saved.stories.map(({ id, title, priority }) => ({ id, title, priority })),
      danglingSourceRefs: Array.from(new Set(dangling)).slice(0, 10),
      note:
        dangling.length > 0
          ? '有些 sourceRefs 不在需求条目里，覆盖率会算不到；需要的话用真实条目 id 修正。'
          : '故事已保存。',
    });
  }

  if (name === 'req_save_check') {
    const rule = auditStories(doc);
    const byTitle = new Map(
      doc.stories.filter((story) => story.title).map((story) => [keyOf(story.title), story.id]),
    );
    const knownIds = new Set(doc.stories.map((story) => story.id));
    const rawGaps = Array.isArray(args.gaps) ? args.gaps : [];
    const modelGaps: ReqGap[] = [];
    for (const raw of rawGaps) {
      const item = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      const title = str(item.title, 200);
      if (!title) continue;
      const rawStoryId = str(item.storyId, 20);
      const storyId =
        (knownIds.has(rawStoryId) && rawStoryId) ||
        byTitle.get(keyOf(str(item.storyTitle, 200))) ||
        '';
      const type = typeOf(item.type);
      modelGaps.push({
        id: gapId(type, storyId, title),
        storyId,
        type,
        severity: severityOf(item.severity),
        title,
        detail: str(item.detail, 1000),
        suggestion: str(item.suggestion, 1000),
        origin: 'model',
        selected: false,
      });
    }
    const gaps = mergeCheckGaps(rule.gaps, modelGaps);
    const summary = str(args.summary, 1500) || rule.summary;
    await ctx.saveCheck({ ...rule, summary, gaps });
    return JSON.stringify({
      ok: true,
      gaps: gaps.length,
      high: gaps.filter((gap) => gap.severity === 'high').length,
      coverage: rule.coverage,
      dimensions: rule.dimensions.map((dim) => ({
        label: dim.label,
        covered: dim.covered,
      })),
      note: `体检报告已保存：整体 ${gaps.length} 个缺口（高 ${gaps.filter((gap) => gap.severity === 'high').length} 个），覆盖率 ${Math.round(rule.coverage.rate * 100)}%。用户可以在页面上勾选缺口补写。`,
    });
  }

  return JSON.stringify({ ok: false, error: `未知工具：${name}` });
}

/* ------------------------------ 兜底解析 ------------------------------ */

function collectJsonBlocks(text: string): string[] {
  const out: string[] = [];
  const re = /```json\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match[1]?.trim()) out.push(match[1].trim());
  }
  return out;
}

/**
 * 模型没调工具时的兜底：从回答里的 ```json 代码块找故事数组。
 * 认 `{ "stories": [...] }` 或裸数组；解析不出来返回空数组（调用方据此提示重试）。
 */
export function parseStoriesFallback(text: string): ReqStoryDraft[] {
  const blocks = collectJsonBlocks(String(text ?? ''));
  for (const block of blocks) {
    try {
      const parsed = JSON.parse(block) as unknown;
      const list = Array.isArray(parsed)
        ? parsed
        : parsed &&
            typeof parsed === 'object' &&
            Array.isArray((parsed as { stories?: unknown }).stories)
          ? (parsed as { stories: unknown[] }).stories
          : null;
      if (!list?.length) continue;
      const stories = list.filter((item): item is ReqStoryDraft =>
        Boolean(item && typeof item === 'object' && typeof (item as ReqStory).title === 'string'),
      );
      if (stories.length) return stories;
    } catch {
      // 继续看下一个代码块
    }
  }
  return [];
}

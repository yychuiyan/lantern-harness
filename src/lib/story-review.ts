/**
 * 用户故事审查：插件提示词接口 + 报告分组与导出。
 *
 * 审查结果不单独存一份数据，直接复用「需求分析」文档的 `check` 字段：
 * 规则结论来自 `auditStories`（确定性），模型只补语义缺口。
 * 本文件只做「取提示词 / 分组 / 导出」，审查执行留在工作台组件里。
 */
import {
  GAP_SEVERITY_LABEL,
  GAP_TYPE_LABEL,
  REQ_STATUS_META,
  type ReqAnalysisDoc,
  type ReqCheckReport,
  type ReqGap,
} from './req-analysis';

export const STORY_REVIEW_API = '/__tb_storyreview';
export const STORY_REVIEW_PROMPT_FILE = '用户故事审查提示词.md';

export interface StoryReviewPrompt {
  file: string;
  exists: boolean;
  /** `## 审查` 段：体检 system prompt */
  review: string;
  /** `## 补写` 段：按勾选缺口补写 */
  fix: string;
  error?: string;
}

export interface StoryReviewPromptSync {
  ok: boolean;
  enabled: boolean;
  file: string;
  created?: boolean;
  updated?: boolean;
  exists?: boolean;
  removed?: boolean;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${STORY_REVIEW_API}${path}`, {
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

export async function fetchStoryReviewHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${STORY_REVIEW_API}?health=1`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

/** 读提示词两段；读不到时不抛错，把原因放在 `error` 里，审查只保留规则结果 */
export async function fetchStoryReviewPrompt(): Promise<StoryReviewPrompt> {
  try {
    const json = await request<Omit<StoryReviewPrompt, 'file'>>('/prompt');
    return {
      file: STORY_REVIEW_PROMPT_FILE,
      exists: json.exists === true,
      review: json.review ?? '',
      fix: json.fix ?? '',
    };
  } catch (err) {
    return {
      file: STORY_REVIEW_PROMPT_FILE,
      exists: false,
      review: '',
      fix: '',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** 开关联动：enabled=true 缺提示词就补种子；false 只停用、不删文件 */
export async function syncStoryReviewPrompt(enabled: boolean): Promise<StoryReviewPromptSync> {
  return request<StoryReviewPromptSync>('/prompt/sync', {
    method: 'POST',
    body: JSON.stringify({ enabled }),
  });
}

/* ------------------------------ 报告分组 ------------------------------ */

export type ReviewGroupKey = 'scenario' | 'dimension' | 'other';

export interface ReviewGroup {
  key: ReviewGroupKey;
  label: string;
  /** 这一组为什么值得先看，展示在分组标题右侧 */
  hint: string;
  gaps: ReqGap[];
}

const SEVERITY_RANK: Record<ReqGap['severity'], number> = { high: 0, medium: 1, low: 2 };

/**
 * 把缺口按「场景遗漏 / 维度缺失 / 其它」分组。
 * 前两组是本插件的核心（专查这两类），其余归到「其它」但不清掉，避免漏看。
 */
export function groupReviewGaps(gaps: readonly ReqGap[]): ReviewGroup[] {
  const bucket: Record<ReviewGroupKey, ReqGap[]> = { scenario: [], dimension: [], other: [] };
  for (const gap of gaps) {
    if (gap.type === 'missing-scenario') bucket.scenario.push(gap);
    else if (gap.type === 'missing-dimension') bucket.dimension.push(gap);
    else bucket.other.push(gap);
  }
  const sort = (list: ReqGap[]) =>
    [...list].sort(
      (a, b) =>
        SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
        a.title.localeCompare(b.title, 'zh'),
    );
  return [
    {
      key: 'scenario',
      label: '场景遗漏',
      hint: '角色 / 分支 / 失败路径没写到',
      gaps: sort(bucket.scenario),
    },
    {
      key: 'dimension',
      label: '维度缺失',
      hint: '六个维度里该覆盖却没提',
      gaps: sort(bucket.dimension),
    },
    {
      key: 'other',
      label: '其它问题',
      hint: '验收不可测 / 冲突 / 过度拆分等',
      gaps: sort(bucket.other),
    },
  ].filter((group): group is ReviewGroup => group.gaps.length > 0);
}

export function countGapsBySeverity(gaps: readonly ReqGap[]): Record<ReqGap['severity'], number> {
  return {
    high: gaps.filter((gap) => gap.severity === 'high').length,
    medium: gaps.filter((gap) => gap.severity === 'medium').length,
    low: gaps.filter((gap) => gap.severity === 'low').length,
  };
}

/* ------------------------------ 导出 ------------------------------ */

/** 导出审查报告：覆盖率、维度覆盖、按分组列缺口（浏览器下载，不落盘） */
export function reviewToMarkdown(doc: ReqAnalysisDoc, check: ReqCheckReport | null): string {
  const lines: string[] = [];
  lines.push(`# 用户故事审查报告 · ${doc.title || '未命名分析'}`);
  lines.push('');
  lines.push(`> 来源：\`${doc.sourcePath || '（未指定）'}\` · 故事 ${doc.stories.length} 条`);
  lines.push('');
  if (!check) {
    lines.push('- 还没有审查结果。');
    return `${lines.join('\n')}\n`;
  }
  const pct = check.coverage.total ? Math.round(check.coverage.rate * 100) : 0;
  lines.push('## 结论');
  lines.push('');
  lines.push(`- 状态：${REQ_STATUS_META[doc.status]?.label ?? doc.status}`);
  lines.push(`- 审查时间：${check.at}`);
  lines.push(`- 需求条目覆盖率：${check.coverage.covered}/${check.coverage.total}（${pct}%）`);
  lines.push(
    `- 维度覆盖：${
      check.dimensions.map((d) => `${d.label}${d.covered ? ' ✓' : ' ✗'}`).join(' · ') || '（无）'
    }`,
  );
  const sev = countGapsBySeverity(check.gaps);
  lines.push(
    `- 缺口：${check.gaps.length} 条（高 ${sev.high} / 中 ${sev.medium} / 低 ${sev.low}）`,
  );
  if (check.summary) {
    lines.push('');
    lines.push(check.summary);
  }
  lines.push('');

  const storyTitle = new Map(doc.stories.map((story) => [story.id, story.title]));
  const groups = groupReviewGaps(check.gaps);
  if (!groups.length) {
    lines.push('## 缺口清单');
    lines.push('');
    lines.push('- 没有发现缺口。');
    return `${lines.join('\n')}\n`;
  }
  for (const group of groups) {
    lines.push(`## ${group.label}（${group.gaps.length}）`);
    lines.push('');
    for (const gap of group.gaps) {
      const where = gap.storyId
        ? `${gap.storyId}${storyTitle.get(gap.storyId) ? ` ${storyTitle.get(gap.storyId)}` : ''}`
        : '全局';
      lines.push(
        `- **[${GAP_SEVERITY_LABEL[gap.severity]}] ${GAP_TYPE_LABEL[gap.type]}** · ${where} · ${gap.title}`,
      );
      if (gap.detail) lines.push(`  - 原因：${gap.detail}`);
      if (gap.suggestion) lines.push(`  - 建议：${gap.suggestion}`);
    }
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/** 下载审查报告；文件名带上分析与日期，多次导出不互相覆盖 */
export function downloadReviewMarkdown(doc: ReqAnalysisDoc, check: ReqCheckReport | null): string {
  const safe = (doc.title || '需求分析').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
  const day = new Date().toISOString().slice(0, 10);
  const name = `${safe}-审查报告-${day}.md`;
  const blob = new Blob([reviewToMarkdown(doc, check)], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
  return name;
}

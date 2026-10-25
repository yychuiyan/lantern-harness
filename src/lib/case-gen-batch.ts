/**
 * 用例生成自动分片：测试点过多时拆成多批 LLM 调用，合并后再入库。
 * 界面仍是一次发送；ChatApp 串行跑批。
 */
import type { CaseGenPluginConfig } from './case-gen-config';

/** 单批测试点上限：完整用例 JSON 需落在常见 ~64k 输出顶之内 */
export const CASE_GEN_BATCH_SIZE = 40;

/** 超过此数量才启用分片（含等于 batch size 时仍一次跑完） */
export const CASE_GEN_BATCH_THRESHOLD = CASE_GEN_BATCH_SIZE;

export interface CaseGenBatchPlan {
  index: number;
  total: number;
  /** 本批测试点 id（有序） */
  ids: string[];
  /** 本批注入用的测试点 Markdown */
  testPointBlock: string;
  /** 进度条展示用短标签 */
  label: string;
}

interface TpSegment {
  id: string;
  storyHeader: string;
  lines: string[];
}

const TP_ID_RE = /（\s*(TP-[A-Za-z0-9_-]+)\s*）|\(\s*(TP-[A-Za-z0-9_-]+)\s*\)/i;

/** 从测试点注入块拆出「每条 TP 一段」，保留所属 #### 故事标题 */
export function parseTestPointBlockSegments(block: string): TpSegment[] {
  const text = String(block || '').replace(/\r\n/g, '\n');
  if (!text.trim()) return [];
  const lines = text.split('\n');
  const segments: TpSegment[] = [];
  let storyHeader = '';
  let cur: TpSegment | null = null;

  const flush = () => {
    if (cur && cur.lines.some((l) => l.trim())) segments.push(cur);
    cur = null;
  };

  for (const line of lines) {
    if (/^#{1,6}\s/.test(line.trim()) || /^#{1,6}\s/.test(line)) {
      flush();
      storyHeader = line;
      continue;
    }
    if (/^\s*-\s+\*\*/.test(line)) {
      const m = line.match(TP_ID_RE);
      const id = (m?.[1] || m?.[2] || '').toUpperCase();
      flush();
      cur = { id: id || `anon_${segments.length + 1}`, storyHeader, lines: [line] };
      continue;
    }
    if (cur) cur.lines.push(line);
  }
  flush();
  return segments;
}

/** 按 id 子集重建注入块（保持原故事标题分组） */
export function rebuildTestPointBlock(
  segments: readonly TpSegment[],
  ids: readonly string[],
): string {
  if (!ids.length) return '';
  const want = new Set(ids.map((id) => id.toUpperCase()));
  const picked = segments.filter((s) => want.has(s.id.toUpperCase()));
  if (!picked.length) return '';
  const lines: string[] = [];
  let lastHeader = '\u0000';
  for (const seg of picked) {
    if (seg.storyHeader && seg.storyHeader !== lastHeader) {
      lastHeader = seg.storyHeader;
      lines.push(seg.storyHeader);
    }
    lines.push(...seg.lines);
  }
  return lines.join('\n').trim();
}

function chunkIds<T>(list: readonly T[], size: number): T[][] {
  const n = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n) as T[]);
  return out;
}

/**
 * 规划分片。无测试点或条数未超阈值 → 单批（调用方仍可走原单次流）。
 * 优先按 testPointIds 顺序切；块解析得到的段用于拼本批 Markdown。
 */
export function planCaseGenBatches(
  cfg: CaseGenPluginConfig,
  opts?: { maxPerBatch?: number; threshold?: number },
): CaseGenBatchPlan[] {
  const maxPerBatch = opts?.maxPerBatch ?? CASE_GEN_BATCH_SIZE;
  const threshold = opts?.threshold ?? CASE_GEN_BATCH_THRESHOLD;
  const ids = (cfg.testPointIds ?? []).map((id) => String(id).trim()).filter(Boolean);
  if (ids.length <= threshold) {
    return [
      {
        index: 1,
        total: 1,
        ids,
        testPointBlock: cfg.testPointBlock ?? '',
        label: ids.length ? `${ids.length} 条测试点` : '全量',
      },
    ];
  }

  const segments = parseTestPointBlockSegments(cfg.testPointBlock ?? '');
  const segById = new Map(segments.map((s) => [s.id.toUpperCase(), s]));
  // ids 顺序为准；块里缺段时仍保留 id，本批 block 可能略瘦
  const orderedIds = ids.map((id) => id.toUpperCase());
  const groups = chunkIds(orderedIds, maxPerBatch);
  const total = groups.length;

  return groups.map((group, i) => {
    const segs = group.map((id) => segById.get(id)).filter(Boolean) as TpSegment[];
    const block =
      segs.length > 0
        ? rebuildTestPointBlock(segs, group)
        : sliceTestPointBlockFallback(cfg.testPointBlock ?? '', group);
    const first = group[0] ?? '';
    const last = group[group.length - 1] ?? '';
    return {
      index: i + 1,
      total,
      ids: group,
      testPointBlock: block,
      label: `${first}…${last}（${group.length} 条）`,
    };
  });
}

/** 块解析失败时的兜底：按 id 行粗筛（可能丢缩进细节，仍优于整包） */
function sliceTestPointBlockFallback(block: string, ids: readonly string[]): string {
  const want = new Set(ids.map((id) => id.toUpperCase()));
  const lines = String(block || '')
    .replace(/\r\n/g, '\n')
    .split('\n');
  const out: string[] = [];
  let storyHeader = '';
  let keep = false;
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) {
      storyHeader = line;
      keep = false;
      continue;
    }
    if (/^\s*-\s+\*\*/.test(line)) {
      const m = line.match(TP_ID_RE);
      const id = (m?.[1] || m?.[2] || '').toUpperCase();
      keep = Boolean(id && want.has(id));
      if (keep) {
        if (storyHeader && out[out.length - 1] !== storyHeader) out.push(storyHeader);
        out.push(line);
      }
      continue;
    }
    if (keep) out.push(line);
  }
  return out.join('\n').trim();
}

/** 为本批生成覆盖后的插件配置（浅拷贝 + 收窄测试点） */
export function caseGenConfigForBatch(
  cfg: CaseGenPluginConfig,
  batch: CaseGenBatchPlan,
): CaseGenPluginConfig {
  return {
    ...cfg,
    testPointIds: batch.ids.length ? batch.ids : cfg.testPointIds,
    testPointBlock: batch.testPointBlock || cfg.testPointBlock,
  };
}

export function shouldBatchCaseGen(cfg: CaseGenPluginConfig): boolean {
  return planCaseGenBatches(cfg).length > 1;
}

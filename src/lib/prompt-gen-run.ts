/**
 * 生成提示词插件：构建系统提示、解析结果、质检、写入 prompts/
 */
import { isPluginEnabled, loadPluginEnabled, pluginDisabledMessage } from './plugins';
import type { PromptGenPluginConfig } from './prompt-gen-config';
import { promptKindMeta } from './prompt-kinds';
import { isPromptLocked, promptLockedReason } from './prompts-meta';
import { listDocs, writeDocsText } from './project-docs';

export interface PromptGenPayload {
  title: string;
  body: string;
  qcPass: boolean;
  qcIssues: string[];
  qcNote: string;
}

export function extractPromptGenPayload(text: string): PromptGenPayload | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence?.[1] ?? text.match(/\{[\s\S]*\}/)?.[0];
  if (!candidate) return null;
  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return null;
    const titleRaw = parsed['提示词名称'] ?? parsed.title ?? parsed.name;
    const bodyRaw = parsed['正文'] ?? parsed.body ?? parsed.content ?? parsed.markdown;
    const title = typeof titleRaw === 'string' ? titleRaw.trim() : '';
    const body = typeof bodyRaw === 'string' ? bodyRaw.trim() : '';
    if (!body) return null;
    const passRaw = parsed['质检通过'] ?? parsed.qcPass ?? parsed.pass;
    const qcPass =
      typeof passRaw === 'boolean'
        ? passRaw
        : typeof passRaw === 'string'
          ? !/^(false|0|no|否|未通过|fail)/i.test(passRaw.trim())
          : true;
    const issuesRaw = parsed['质检问题'] ?? parsed.qcIssues ?? parsed.issues;
    const qcIssues = Array.isArray(issuesRaw)
      ? issuesRaw.map((x) => String(x).trim()).filter(Boolean)
      : typeof issuesRaw === 'string' && issuesRaw.trim()
        ? [issuesRaw.trim()]
        : [];
    const noteRaw = parsed['质检说明'] ?? parsed.qcNote ?? parsed.note;
    const qcNote = typeof noteRaw === 'string' ? noteRaw.trim() : '';
    return { title, body, qcPass, qcIssues, qcNote };
  } catch {
    return null;
  }
}

export function safePromptFileBase(name: string): string {
  return (
    name
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, '')
      .replace(/\.md$/i, '')
      .slice(0, 64) || '未命名提示词'
  );
}

/** 入库前质检：模型自检 + 本地硬规则 */
export function qualityCheckPrompt(
  payload: PromptGenPayload,
  titleHint = '',
): {
  ok: boolean;
  issues: string[];
  title: string;
  fileBase: string;
} {
  const issues = [...payload.qcIssues];
  const title = (payload.title || titleHint || '未命名提示词').trim();
  if (!payload.qcPass) {
    issues.push('模型自检未通过（质检通过=false）');
  }
  if (!title || title.length < 2) issues.push('提示词名称过短（至少 2 字）');
  if (title.length > 80) issues.push('提示词名称过长（最多 80 字）');
  if (/[\\/]/.test(title)) issues.push('提示词名称不可包含路径分隔符');
  const fileBase = safePromptFileBase(title);
  const fileName = `${fileBase}.md`;
  if (isPromptLocked(fileName, loadPluginEnabled())) {
    issues.push(
      `不可覆盖受保护提示词「${fileName}」：${promptLockedReason(fileName, loadPluginEnabled())}`,
    );
  }
  if (!payload.body.trim()) issues.push('正文为空');
  else if (payload.body.trim().length < 80) issues.push('正文过短（建议不少于 80 字）');
  if (!/^#\s+/m.test(payload.body) && !payload.body.includes('\n')) {
    issues.push('正文建议使用 Markdown 标题与分段结构');
  }
  // 去重
  const uniq = [...new Set(issues.filter(Boolean))];
  return { ok: uniq.length === 0, issues: uniq, title, fileBase };
}

export function buildPromptGenSystemPrompt(cfg: PromptGenPluginConfig): string {
  const kindHint = promptKindMeta(cfg.kind).hint;
  const titleHint = cfg.titleHint.trim() || '（可在结果中自拟简洁中文名）';
  return `你是资深提示词工程师，擅长为测试与研发场景编写可落地的中文提示词。

【任务】
根据用户在对话中的需求，编写一份完整的 Markdown 提示词正文，供后续入库到提示词库。
具体要求以用户本轮及近期对话输入为准。

【类型】
${kindHint}

【用户期望名称】
${titleHint}

【输出前自检（必须）】
1. 角色与目标是否清晰？
2. 约束是否可执行、无互相矛盾？
3. 是否避免空话与不可判定要求？
4. 用例类提示词：是否要求按模板字段输出、步骤换行、按需求覆盖（不设固定条数）？
5. 若未通过，将「质检通过」设为 false，并在「质检问题」列出具体项。

【输出格式（强制）】
仅输出一个 JSON 对象（可无代码围栏），不要其它解释：
{
  "提示词名称": "简短中文名（不含 .md）",
  "质检通过": true,
  "质检问题": [],
  "质检说明": "一句话说明质检结论",
  "正文": "# 标题\\n\\n完整 Markdown 正文……"
}

约束：
- 「正文」为完整 Markdown 字符串，可含换行；不要把正文拆到 JSON 外。
- 「质检通过」为 false 时系统不会入库。
- 不要输出 JSON 以外的闲聊；界面只展示执行摘要。`;
}

/** @param elapsedSec 已用秒数（从请求开始计） */
export function formatPromptGenProgress(elapsedSec = 0): string {
  const sec = Math.max(0, Math.floor(elapsedSec));
  const pct = Math.min(95, Math.max(1, Math.round(95 * (1 - Math.exp(-sec / 90)))));
  return (
    `正在编写提示词…\n\n` +
    `进度约 ${pct}% · 已用 ${sec}s\n` +
    `完成后将质检并自动入库到提示词管理。`
  );
}

export function formatPromptGenResultSummary(opts: {
  ok: boolean;
  title?: string;
  path?: string;
  qcNote?: string;
  issues?: string[];
  error?: string;
}): string {
  if (!opts.ok) {
    const lines = ['**执行失败 / 未入库**', '', opts.error || '质检未通过或解析失败'];
    const issues = opts.issues ?? [];
    if (issues.length) {
      lines.push('', '**质检问题**');
      for (const i of issues) lines.push(`- ${i}`);
    }
    lines.push('', '可在对话中补充要求后重新发送，或在插件中修改名称/类型。');
    return lines.join('\n');
  }
  const lines = ['**执行成功**', '', `- 提示词名称：${opts.title || '—'}`];
  if (opts.path) lines.push(`- 入库文件：提示词管理/${opts.path}`);
  if (opts.qcNote) {
    lines.push('', '**质检说明**', opts.qcNote);
  }
  lines.push('', '下方卡片可点击打开文件。');
  return lines.join('\n');
}

async function uniquePromptRel(fileBase: string): Promise<string> {
  const rel = `${fileBase}.md`;
  try {
    const { entries } = await listDocs('prompts', '.');
    const names = new Set(entries.filter((e) => e.type === 'file').map((e) => e.name));
    if (!names.has(rel)) return rel;
    for (let i = 2; i < 100; i++) {
      const cand = `${fileBase}-${i}.md`;
      if (!names.has(cand)) return cand;
    }
  } catch {
    // ignore list failure — overwrite risk low if write fails later
  }
  return `${fileBase}-${Date.now().toString(36)}.md`;
}

export async function tryFinishPromptGenFromAssistant(
  raw: string,
  cfg: PromptGenPluginConfig,
): Promise<
  | {
      ok: true;
      path: string;
      title: string;
      qcNote: string;
      summary: string;
    }
  | { ok: false; error: string; issues: string[]; summary: string }
> {
  const payload = extractPromptGenPayload(raw);
  if (!payload) {
    const error = '未能解析出提示词结果，未写入文件';
    return {
      ok: false,
      error,
      issues: [],
      summary: formatPromptGenResultSummary({ ok: false, error }),
    };
  }
  const qc = qualityCheckPrompt(payload, cfg.titleHint);
  if (!qc.ok) {
    const error = '入库前质检未通过';
    return {
      ok: false,
      error,
      issues: qc.issues,
      summary: formatPromptGenResultSummary({
        ok: false,
        error,
        issues: qc.issues,
        qcNote: payload.qcNote,
      }),
    };
  }
  if (!isPluginEnabled('prompts')) {
    const error = pluginDisabledMessage('prompts');
    return {
      ok: false,
      error,
      issues: [],
      summary: formatPromptGenResultSummary({ ok: false, error }),
    };
  }
  try {
    const path = await uniquePromptRel(qc.fileBase);
    await writeDocsText(
      'prompts',
      path,
      payload.body.endsWith('\n') ? payload.body : `${payload.body}\n`,
    );
    const summary = formatPromptGenResultSummary({
      ok: true,
      title: qc.title,
      path,
      qcNote: payload.qcNote,
    });
    return { ok: true, path, title: qc.title, qcNote: payload.qcNote, summary };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error,
      issues: [],
      summary: formatPromptGenResultSummary({ ok: false, error }),
    };
  }
}

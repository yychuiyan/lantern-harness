/**
 * 生成知识库插件：构建系统提示、解析结果、质检、写入 knowledge/
 */
import {
  isKnownKnowledgeCategory,
  type KnowledgeCategory,
  type KnowledgeGenPluginConfig,
} from './knowledge-gen-config';
import { listKnowledgeCategories } from './knowledge-categories';
import { isPluginEnabled, pluginDisabledMessage } from './plugins';
import { listDocs, writeDocsText } from './project-docs';

export interface KnowledgeGenPayload {
  title: string;
  category: KnowledgeCategory | string;
  description: string;
  body: string;
  qcPass: boolean;
  qcIssues: string[];
  qcNote: string;
}

export function extractKnowledgeGenPayload(text: string): KnowledgeGenPayload | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence?.[1] ?? text.match(/\{[\s\S]*\}/)?.[0];
  if (!candidate) return null;
  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return null;
    const titleRaw = parsed['标题'] ?? parsed['知识库名称'] ?? parsed.title ?? parsed.name;
    const catRaw = parsed['分类'] ?? parsed.category;
    const descRaw = parsed['描述'] ?? parsed.description;
    const bodyRaw = parsed['正文'] ?? parsed.body ?? parsed.content ?? parsed.markdown;
    const title = typeof titleRaw === 'string' ? titleRaw.trim() : '';
    const category = typeof catRaw === 'string' ? catRaw.trim() : '';
    const description = typeof descRaw === 'string' ? descRaw.trim() : '';
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
    return { title, category, description, body, qcPass, qcIssues, qcNote };
  } catch {
    return null;
  }
}

export function safeKnowledgeFileBase(name: string): string {
  return (
    name
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, '')
      .replace(/\.md$/i, '')
      .slice(0, 64) || '未命名知识'
  );
}

function yamlScalar(value: string): string {
  const s = value.trim();
  // 含特殊字符时用双引号，避免 frontmatter 解析失败
  if (!s || /[:#{}[\],&*?|>!<>=%@`"'\\\n]/.test(s) || /^\s|\s$/.test(value)) {
    return JSON.stringify(s);
  }
  return s;
}

/** 去掉正文里已有的 frontmatter，避免重复包裹 */
function stripLeadingFrontmatter(raw: string): string {
  const m = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
  return (m?.[1] ?? raw).trim();
}

export function buildKnowledgeMarkdown(opts: {
  title: string;
  category: KnowledgeCategory;
  description: string;
  body: string;
}): string {
  const desc = opts.description.trim();
  const stripped = stripLeadingFrontmatter(opts.body);
  const body = stripped.startsWith('#') ? stripped : `# ${opts.title}\n\n${stripped}`;
  const lines = [
    '---',
    `title: ${yamlScalar(opts.title)}`,
    `category: ${yamlScalar(opts.category)}`,
  ];
  if (desc) lines.push(`description: ${yamlScalar(desc)}`);
  lines.push('---', '', body, '');
  return lines.join('\n');
}

export function qualityCheckKnowledge(
  payload: KnowledgeGenPayload,
  cfg: KnowledgeGenPluginConfig,
): {
  ok: boolean;
  issues: string[];
  title: string;
  category: KnowledgeCategory;
  fileBase: string;
  description: string;
} {
  const issues = [...payload.qcIssues];
  const title = (payload.title || cfg.titleHint || '未命名知识').trim();
  let category = (payload.category || cfg.category || '').trim() as KnowledgeCategory | string;
  if (!isKnownKnowledgeCategory(category)) category = cfg.category;
  if (!payload.qcPass) issues.push('模型自检未通过（质检通过=false）');
  if (!title || title.length < 2) issues.push('标题过短（至少 2 字）');
  if (title.length > 80) issues.push('标题过长（最多 80 字）');
  if (/[\\/]/.test(title)) issues.push('标题不可包含路径分隔符');
  if (!isKnownKnowledgeCategory(category)) {
    issues.push(`分类必须是：${listKnowledgeCategories().join(' / ')}`);
  }
  if (!payload.body.trim()) issues.push('正文为空');
  else if (payload.body.trim().length < 60) issues.push('正文过短（建议不少于 60 字）');
  const uniq = [...new Set(issues.filter(Boolean))];
  return {
    ok: uniq.length === 0,
    issues: uniq,
    title,
    category: category as KnowledgeCategory,
    fileBase: safeKnowledgeFileBase(title),
    description: (payload.description || '').trim().slice(0, 120),
  };
}

export function buildKnowledgeGenSystemPrompt(cfg: KnowledgeGenPluginConfig): string {
  const titleHint = cfg.titleHint.trim() || '（可在结果中自拟简洁中文名）';
  return `你是资深测试知识库编辑，擅长把规范、方法论、环境约定写成可复用的 Markdown 文档。

【任务】
根据用户在对话中提供的素材/需求，编写一份完整的知识库 Markdown 正文，入库到知识库对应分类目录。
具体要求以用户本轮及近期对话输入为准。

【目标分类】
${cfg.category}
（分类仅限：${listKnowledgeCategories().join(' / ')}；不要写成需求文档或测试用例）

【用户期望标题】
${titleHint}

【内容要求】
1. 结构清晰：标题、条目/表格/步骤可执行；避免空话。
2. 可复用：适合后续对话用「@」引用。
3. 不要输出用例表格字段集；不要写成需求 PRD。

【输出前自检（必须）】
1. 分类是否正确？
2. 标题是否简洁可作文件名？
3. 正文是否可落地、无互相矛盾？
4. 若未通过，将「质检通过」设为 false，并在「质检问题」列出具体项。

【输出格式（强制）】
仅输出一个 JSON 对象（可无代码围栏），不要其它解释：
{
  "标题": "简短中文名（不含 .md）",
  "分类": "${cfg.category}",
  "描述": "一句话摘要",
  "质检通过": true,
  "质检问题": [],
  "质检说明": "一句话说明质检结论",
  "正文": "# 标题\\n\\n完整 Markdown 正文……"
}

约束：
- 「正文」为完整 Markdown 字符串（可含换行）；frontmatter 由系统自动拼接，正文不要再写 --- frontmatter。
- 「质检通过」为 false 时系统不会入库。
- 不要输出 JSON 以外的闲聊；界面只展示执行摘要。`;
}

/** @param elapsedSec 已用秒数（从请求开始计） */
export function formatKnowledgeGenProgress(elapsedSec = 0): string {
  const sec = Math.max(0, Math.floor(elapsedSec));
  const pct = Math.min(95, Math.max(1, Math.round(95 * (1 - Math.exp(-sec / 90)))));
  return (
    `正在编写知识库文档…\n\n` +
    `进度约 ${pct}% · 已用 ${sec}s\n` +
    `完成后将质检并自动入库到知识库管理。`
  );
}

export function formatKnowledgeGenResultSummary(opts: {
  ok: boolean;
  title?: string;
  path?: string;
  category?: string;
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
    lines.push('', '可调整说明后重新发送，或在插件中修改分类/标题。');
    return lines.join('\n');
  }
  const lines = ['**执行成功**', '', `- 标题：${opts.title || '—'}`];
  if (opts.category) lines.push(`- 分类：${opts.category}`);
  if (opts.path) lines.push(`- 入库文件：知识库管理/${opts.path}`);
  if (opts.qcNote) {
    lines.push('', '**质检说明**', opts.qcNote);
  }
  lines.push('', '下方卡片可点击打开文件；对话中也可用「@」引用（构建后或刷新列表）。');
  return lines.join('\n');
}

/** 平铺写入 知识库管理/ 根目录；分类只记录在 frontmatter 的 category（与用例一致） */
async function uniqueKnowledgeRel(fileBase: string): Promise<string> {
  const rel = `${fileBase}.md`;
  try {
    const { entries } = await listDocs('knowledge', '.');
    const names = new Set(entries.filter((e) => e.type === 'file').map((e) => e.name));
    if (!names.has(rel)) return rel;
    for (let i = 2; i < 100; i++) {
      const cand = `${fileBase}-${i}.md`;
      if (!names.has(cand)) return cand;
    }
  } catch {
    // ignore
  }
  return `${fileBase}-${Date.now().toString(36)}.md`;
}

export async function tryFinishKnowledgeGenFromAssistant(
  raw: string,
  cfg: KnowledgeGenPluginConfig,
): Promise<
  | {
      ok: true;
      path: string;
      title: string;
      category: KnowledgeCategory;
      qcNote: string;
      summary: string;
    }
  | { ok: false; error: string; issues: string[]; summary: string }
> {
  const payload = extractKnowledgeGenPayload(raw);
  if (!payload) {
    const error = '未能解析出知识库结果，未写入文件';
    return {
      ok: false,
      error,
      issues: [],
      summary: formatKnowledgeGenResultSummary({ ok: false, error }),
    };
  }
  const qc = qualityCheckKnowledge(payload, cfg);
  if (!qc.ok) {
    const error = '入库前质检未通过';
    return {
      ok: false,
      error,
      issues: qc.issues,
      summary: formatKnowledgeGenResultSummary({
        ok: false,
        error,
        issues: qc.issues,
        qcNote: payload.qcNote,
      }),
    };
  }
  if (!isPluginEnabled('knowledgeLib')) {
    const error = pluginDisabledMessage('knowledgeLib');
    return {
      ok: false,
      error,
      issues: [],
      summary: formatKnowledgeGenResultSummary({ ok: false, error }),
    };
  }
  try {
    const rel = await uniqueKnowledgeRel(qc.fileBase);
    const md = buildKnowledgeMarkdown({
      title: qc.title,
      category: qc.category,
      description: qc.description,
      body: payload.body,
    });
    await writeDocsText('knowledge', rel, md.endsWith('\n') ? md : `${md}\n`);
    const summary = formatKnowledgeGenResultSummary({
      ok: true,
      title: qc.title,
      path: rel,
      category: qc.category,
      qcNote: payload.qcNote,
    });
    return {
      ok: true,
      path: rel,
      title: qc.title,
      category: qc.category,
      qcNote: payload.qcNote,
      summary,
    };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error,
      issues: [],
      summary: formatKnowledgeGenResultSummary({ ok: false, error }),
    };
  }
}

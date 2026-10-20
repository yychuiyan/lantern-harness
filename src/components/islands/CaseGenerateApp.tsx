import { useEffect, useMemo, useRef, useState } from 'react';
import {
  caseTypeMeta,
  createCaseSession,
  hydrateCaseSessions,
  listCaseTypes,
  loadCaseSessions,
  saveCaseSessions,
  updateCaseSession,
  type CaseGenResultMeta,
  type CaseOutputFormat,
  type CaseSession,
  type CaseSessionMessage,
  type CaseType,
} from '../../lib/case-sessions';
import { CASE_FIELDS } from '../../lib/export';
import {
  normalizeCaseRows,
  parseCsvTemplate,
  parseMdTemplate,
  parseXlsxTemplateBase64,
  rowsToCsv,
  rowsToMarkdown,
  rowsToXlsxBase64,
  type CaseRow,
} from '../../lib/case-template';
import { streamChat, type ChatMessage } from '../../lib/llm';
import {
  fetchDocsHealth,
  listDocs,
  mkdirDocs,
  openDocsFile,
  readDocsRaw,
  readDocsText,
  writeDocsBinary,
  writeDocsText,
  type DocsEntry,
} from '../../lib/project-docs';
import { docRootLabelPath } from '../../lib/doc-roots';
import { isChatOnlyPrompt } from '../../lib/prompts-meta';
import {
  hydrateAppConfig,
  loadSettings,
  onSettingsChanged,
  openSettings,
  type LLMSettings,
} from '../../lib/settings';
import ExcelFieldTags from './ExcelFieldTags';
import MultiSelectDropdown from './MultiSelectDropdown';
import SearchableSelect from './SearchableSelect';
import SelectDropdown from './SelectDropdown';
import { showToast } from './Toast';

export interface CaseTemplateOpt {
  id: string;
  title: string;
  body: string;
  headers: string[];
}

const FORMAT_OPTS: Array<{ value: CaseOutputFormat; label: string }> = [
  { value: 'md', label: 'Markdown 表格' },
  { value: 'xlsx', label: 'Excel' },
  { value: 'csv', label: 'CSV' },
];

function extractJsonPayload(text: string): { docTitle: string; cases: unknown[] } | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence?.[1] ?? text.match(/\{[\s\S]*\}/)?.[0] ?? text.match(/\[[\s\S]*\]/)?.[0];
  if (!candidate) return null;
  try {
    const parsed = JSON.parse(candidate);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return { docTitle: '', cases: parsed };
    }
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      const cases = obj['用例'] ?? obj.cases ?? obj.items;
      if (!Array.isArray(cases) || cases.length === 0) return null;
      const titleRaw = obj['需求名称'] ?? obj['文档名称'] ?? obj.docTitle ?? obj.title;
      const docTitle = typeof titleRaw === 'string' ? titleRaw.trim() : '';
      return { docTitle, cases };
    }
  } catch {
    return null;
  }
  return null;
}

/** 从需求路径 / 正文提取备用名称 */
function titleFromReqPath(reqPath: string): string {
  const base = reqPath.split('/').pop() || reqPath;
  return base.replace(/\.[^.]+$/, '').trim();
}

function titleFromReqContent(content: string): string {
  const h1 = content.match(/^#\s+(.+)$/m);
  if (h1?.[1]) return h1[1].trim().slice(0, 48);
  const titleLine = content.match(/^标题[:：]\s*(.+)$/m);
  if (titleLine?.[1]) return titleLine[1].trim().slice(0, 48);
  return '';
}

function safeFileBase(name: string): string {
  return (
    name
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, '-')
      .slice(0, 48) || 'cases'
  );
}

function detectOmissions(cases: CaseRow[], headers: string[]): string[] {
  const tips: string[] = [];
  if (!cases.length) {
    tips.push('未生成任何用例');
    return tips;
  }
  for (const h of headers) {
    const empty = cases.filter((c) => !String(c[h] ?? '').trim()).length;
    if (empty === cases.length) tips.push(`字段「${h}」全部为空`);
    else if (empty > Math.max(2, Math.floor(cases.length * 0.3))) {
      tips.push(`字段「${h}」有 ${empty}/${cases.length} 条为空`);
    }
  }
  if (cases.length < 15) tips.push(`用例数量偏少（${cases.length} 条），建议核对需求覆盖`);
  const titles = cases
    .map((c) => {
      for (const k of ['用例标题', '标题', '测试分项目', '测试项目']) {
        if (c[k]?.trim()) return c[k]!.trim();
      }
      return '';
    })
    .filter(Boolean);
  const uniq = new Set(titles);
  if (titles.length >= 4 && uniq.size < titles.length * 0.6) {
    tips.push('用例标题/分项重复偏多，可能覆盖不足');
  }
  return tips;
}

function formatDuration(ms?: number): string {
  if (ms == null || ms < 0) return '—';
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s - m * 60);
  return `${m} 分 ${rem} 秒`;
}

function formatClock(ts?: number): string {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return '—';
  }
}

async function loadTemplatesForType(caseType: CaseType): Promise<CaseTemplateOpt[]> {
  const folder = caseTypeMeta(caseType).templateFolder;
  try {
    const { entries } = await listDocs('templates', folder);
    const files = entries
      .filter((e) => e.type === 'file')
      .sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
    const out: CaseTemplateOpt[] = [];
    for (const f of files) {
      const lower = f.name.toLowerCase();
      // 模板解析结果可能不含默认字段，故按 string[] 存放（默认值来自 CASE_FIELDS）
      let headers: string[] = [...CASE_FIELDS];
      let body = '';
      try {
        if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
          const raw = await readDocsRaw('templates', f.path);
          if (raw.encoding === 'base64' && raw.contentBase64) {
            const parsed = parseXlsxTemplateBase64(raw.contentBase64);
            headers = parsed.headers;
            body = parsed.body;
          }
        } else if (lower.endsWith('.csv')) {
          const r = await readDocsText('templates', f.path);
          const parsed = parseCsvTemplate(r.content);
          headers = parsed.headers;
          body = parsed.body;
        } else if (lower.endsWith('.md') || lower.endsWith('.txt')) {
          const r = await readDocsText('templates', f.path);
          const parsed = parseMdTemplate(r.content);
          headers = parsed.headers;
          body = parsed.body;
        }
      } catch {
        body = '';
      }
      out.push({
        id: f.path,
        title: f.name.replace(/\.[^.]+$/, ''),
        body,
        headers,
      });
    }
    return out;
  } catch {
    return [];
  }
}

async function readRequirementText(reqPath: string): Promise<string> {
  const lower = reqPath.toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.txt') || lower.endsWith('.csv')) {
    const r = await readDocsText('requirements', reqPath);
    return r.content;
  }
  if (lower.endsWith('.docx')) {
    const raw = await readDocsRaw('requirements', reqPath);
    if (raw.encoding !== 'base64' || !raw.contentBase64) {
      throw new Error('无法读取 docx');
    }
    const bin = atob(raw.contentBase64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ arrayBuffer: bytes.buffer });
    return (result.value ?? '').trim();
  }
  throw new Error('该需求文件类型暂不支持正文提取');
}

export default function CaseGenerateApp() {
  const [settings, setSettings] = useState<LLMSettings | null>(null);
  const [docsLive, setDocsLive] = useState(false);
  const [reqFiles, setReqFiles] = useState<DocsEntry[]>([]);
  const [selectedReq, setSelectedReq] = useState('');
  const [caseType, setCaseType] = useState<CaseType>('functional');
  const [templates, setTemplates] = useState<CaseTemplateOpt[]>([]);
  const [templateId, setTemplateId] = useState('');
  const [promptFiles, setPromptFiles] = useState<DocsEntry[]>([]);
  const [promptPath, setPromptPath] = useState('');
  const [promptBody, setPromptBody] = useState('');
  const [knowledgeFiles, setKnowledgeFiles] = useState<DocsEntry[]>([]);
  const [knowledgePaths, setKnowledgePaths] = useState<string[]>([]);
  const [outputFormat, setOutputFormat] = useState<CaseOutputFormat>('md');
  const [input, setInput] = useState('');
  const [session, setSession] = useState<CaseSession | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedFile, setSavedFile] = useState<{ path: string; count: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const template = useMemo(
    () => templates.find((t) => t.id === templateId) ?? templates[0],
    [templates, templateId],
  );

  const activeType = caseType;
  const typeLabel = caseTypeMeta(activeType).label;

  useEffect(() => {
    void hydrateAppConfig().then(() => setSettings(loadSettings()));
    const off = onSettingsChanged(() => setSettings(loadSettings()));
    void (async () => {
      await hydrateCaseSessions();
      const ok = await fetchDocsHealth('requirements');
      const casesOk = await fetchDocsHealth('cases');
      const tplOk = await fetchDocsHealth('templates');
      const promptOk = await fetchDocsHealth('prompts');
      const kbOk = await fetchDocsHealth('knowledge');
      setDocsLive(ok && casesOk && tplOk && promptOk);
      async function walkDocs(
        root: 'requirements' | 'prompts' | 'knowledge',
        dir: string,
        acc: DocsEntry[],
      ) {
        const { entries } = await listDocs(root, dir);
        for (const e of entries) {
          if (e.type === 'file') acc.push(e);
          else await walkDocs(root, e.path, acc);
        }
      }
      if (ok) {
        try {
          const files: DocsEntry[] = [];
          await walkDocs('requirements', '.', files);
          setReqFiles(files);
        } catch {
          // ignore
        }
      }
      if (kbOk) {
        try {
          const files: DocsEntry[] = [];
          await walkDocs('knowledge', '.', files);
          files.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
          setKnowledgeFiles(files);
        } catch {
          // ignore
        }
      }
      if (promptOk) {
        try {
          const files: DocsEntry[] = [];
          await walkDocs('prompts', '.', files);
          const casePrompts = files.filter((f) => !isChatOnlyPrompt(f.path));
          casePrompts.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
          setPromptFiles(casePrompts);
          const prefer =
            casePrompts.find((f) => f.path.includes('功能测试用例提示词'))?.path ??
            casePrompts[0]?.path ??
            '';
          setPromptPath((prev) => {
            if (prev && !isChatOnlyPrompt(prev) && casePrompts.some((x) => x.path === prev)) {
              return prev;
            }
            return prefer;
          });
        } catch {
          // ignore
        }
      }
      const params = new URLSearchParams(window.location.search);
      const sid = params.get('session');
      const pathQ = params.get('path');
      const store = loadCaseSessions();
      if (sid) {
        const s = store.sessions.find((x) => x.id === sid);
        if (s) {
          setSession(s);
          setCaseType(s.caseType);
          setOutputFormat(s.outputFormat);
          setSelectedReq(s.reqPaths[0] ?? '');
          if (s.templateId) setTemplateId(s.templateId);
          if (s.promptPath) setPromptPath(s.promptPath);
          if (s.knowledgePaths?.length) setKnowledgePaths([...s.knowledgePaths]);
          if (s.linkedCasePath) setSavedFile({ path: s.linkedCasePath, count: 0 });
        }
      } else if (pathQ) {
        const existing = store.sessions.find((x) => x.linkedCasePath === pathQ);
        if (existing) {
          setSession(existing);
          setCaseType(existing.caseType);
          setOutputFormat(existing.outputFormat);
          setSelectedReq(existing.reqPaths[0] ?? '');
          if (existing.templateId) setTemplateId(existing.templateId);
          if (existing.promptPath) setPromptPath(existing.promptPath);
          if (existing.knowledgePaths?.length) setKnowledgePaths([...existing.knowledgePaths]);
          if (existing.linkedCasePath) setSavedFile({ path: existing.linkedCasePath, count: 0 });
        } else {
          const ext = pathQ.split('.').pop()?.toLowerCase();
          const fmt: CaseOutputFormat =
            ext === 'csv' ? 'csv' : ext === 'xlsx' || ext === 'xls' ? 'xlsx' : 'md';
          const top = pathQ.split('/')[0] ?? '';
          const inferred =
            listCaseTypes().find((o) => o.casesFolder === top)?.id ??
            listCaseTypes()[0]?.id ??
            'functional';
          const created = createCaseSession({
            title:
              pathQ
                .split('/')
                .pop()
                ?.replace(/\.[^.]+$/, '') || '用例续改',
            caseType: inferred,
            outputFormat: fmt,
            reqPaths: [],
          });
          const next = updateCaseSession(created.id, { linkedCasePath: pathQ });
          const fresh = next.sessions.find((x) => x.id === created.id) ?? null;
          setSession(fresh);
          setCaseType(inferred);
          setOutputFormat(fmt);
          setSavedFile({ path: pathQ, count: 0 });
        }
      }
    })();
    return off;
  }, []);

  useEffect(() => {
    if (!docsLive) return;
    let cancelled = false;
    void loadTemplatesForType(caseType).then((list) => {
      if (cancelled) return;
      setTemplates(list);
      setTemplateId((prev) => {
        if (prev && list.some((x) => x.id === prev)) return prev;
        if (session?.templateId && list.some((x) => x.id === session.templateId)) {
          return session.templateId;
        }
        return list[0]?.id ?? '';
      });
    });
    return () => {
      cancelled = true;
    };
  }, [docsLive, caseType, session?.templateId]);

  useEffect(() => {
    if (!promptPath) {
      setPromptBody('');
      return;
    }
    void readDocsText('prompts', promptPath)
      .then((r) => {
        const text = r.content ?? '';
        setPromptBody(text);
        // 关联提示词读不到 / 是空的：toast 说清楚，别等生成时才发现没提示词
        if (!text.trim()) {
          showToast(`「提示词管理/${promptPath}」是空的，生成前请先补上提示词内容。`, 'error');
        }
      })
      .catch((e) => {
        setPromptBody('');
        const detail = e instanceof Error ? e.message : String(e);
        showToast(`没有读到「提示词管理/${promptPath}」：${detail}`, 'error');
      });
  }, [promptPath]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [session?.messages, streaming]);

  function patchSession(patch: Partial<CaseSession>) {
    if (!session) return;
    const next = updateCaseSession(session.id, patch);
    setSession(next.sessions.find((s) => s.id === session.id) ?? session);
  }

  async function buildContextBlock(): Promise<string> {
    let block = '';
    if (selectedReq) {
      try {
        const content = await readRequirementText(selectedReq);
        block += `\n### 需求文档：${selectedReq}\n${content.slice(0, 16000)}\n`;
      } catch {
        block += `\n### 需求文档：${selectedReq}\n（无法读取正文）\n`;
      }
    }
    if (template?.body) {
      block += `\n### 用例模板：${template.title}\n${template.body.slice(0, 8000)}\n`;
    } else if (template) {
      block += `\n### 用例模板：${template.title}\n字段：${(template.headers.length ? template.headers : CASE_FIELDS).join('、')}\n`;
    }
    for (const kp of knowledgePaths) {
      try {
        const r = await readDocsText('knowledge', kp);
        block += `\n### 知识库：${kp}\n${r.content.slice(0, 6000)}\n`;
      } catch {
        block += `\n### 知识库：${kp}\n（无法读取）\n`;
      }
    }
    return block;
  }

  async function persistCasesToLibrary(
    cases: CaseRow[],
    sess: CaseSession,
    docTitle: string,
    headers: string[],
  ): Promise<string> {
    const meta = caseTypeMeta(sess.caseType);
    const title = docTitle || sess.title || meta.label;
    const base = safeFileBase(title);
    const folder = meta.casesFolder;
    try {
      await mkdirDocs('cases', '.', folder);
    } catch {
      // may exist
    }
    const ext = sess.outputFormat === 'md' ? '.md' : sess.outputFormat === 'csv' ? '.csv' : '.xlsx';
    let rel: string;
    if (sess.linkedCasePath) {
      rel = sess.linkedCasePath;
    } else {
      rel = `${folder}/${base}${ext}`;
    }

    const fields = headers.length ? headers : [...CASE_FIELDS];
    if (sess.outputFormat === 'md') {
      await writeDocsText('cases', rel, rowsToMarkdown(cases, title, fields));
    } else if (sess.outputFormat === 'csv') {
      await writeDocsText('cases', rel, rowsToCsv(cases, fields));
    } else {
      await writeDocsBinary('cases', rel, await rowsToXlsxBase64(cases, fields, meta.label));
    }
    return rel;
  }

  async function resolveDocTitleHint(): Promise<string> {
    if (!selectedReq) return '';
    const fromPath = titleFromReqPath(selectedReq);
    try {
      const content = await readRequirementText(selectedReq);
      return titleFromReqContent(content) || fromPath;
    } catch {
      return fromPath;
    }
  }

  async function runGenerate(userText: string, existing?: CaseSession) {
    if (!settings) {
      openSettings('model');
      return;
    }
    if (!docsLive) {
      setError('本地文档服务未就绪，无法读写用例 / 需求 / 模板库');
      return;
    }

    const docTitleHint = await resolveDocTitleHint();

    let sess = existing;
    if (!sess) {
      sess = createCaseSession({
        title: docTitleHint || userText.slice(0, 24) || '用例生成',
        caseType,
        outputFormat,
        reqPaths: selectedReq ? [selectedReq] : [],
        templateId: template?.id,
        templateTitle: template?.title,
        promptPath: promptPath || undefined,
        knowledgePaths: knowledgePaths.length ? [...knowledgePaths] : undefined,
      });
      setSession(sess);
    } else {
      // 生成前同步最新选项（允许生成后继续改）
      updateCaseSession(sess.id, {
        caseType,
        outputFormat,
        reqPaths: selectedReq ? [selectedReq] : [],
        templateId: template?.id,
        templateTitle: template?.title,
        promptPath: promptPath || undefined,
        knowledgePaths: knowledgePaths.length ? [...knowledgePaths] : undefined,
      });
      sess = {
        ...sess,
        caseType,
        outputFormat,
        reqPaths: selectedReq ? [selectedReq] : [],
        templateId: template?.id,
        templateTitle: template?.title,
        promptPath: promptPath || undefined,
        knowledgePaths: knowledgePaths.length ? [...knowledgePaths] : undefined,
      };
    }

    const ctx = await buildContextBlock();
    const label = caseTypeMeta(caseType).label;
    const fields = template?.headers?.length ? template.headers : [...CASE_FIELDS];
    const formatHint =
      outputFormat === 'md'
        ? '最终结果将保存为 Markdown 表格文件'
        : outputFormat === 'csv'
          ? '最终结果将保存为 CSV 文件'
          : '最终结果将保存为 Excel 文件';

    const promptCore = promptBody.trim();
    if (!promptCore) {
      const message = promptPath
        ? `「提示词管理/${promptPath}」没读到内容，请先在提示词管理里补上`
        : '请先选择提示词';
      setError(message);
      showToast(message, 'error');
      return;
    }

    const system = `${promptCore}

【运行时约束】
- 用例类型：${label}
- ${formatHint}
- 需求名称默认可用「${docTitleHint || '未命名需求'}」
- 「用例」对象键必须与模板字段完全一致：${fields.join('、')}
- 仅输出 JSON 对象：{"需求名称":"...","覆盖需求率":0-100,"未覆盖说明":[],"编写说明":"...","用例":[...]}，不要其他解释`;

    const history: ChatMessage[] = [
      { role: 'system', content: system },
      {
        role: 'user',
        content: `${ctx}\n\n【用户请求】\n${userText}`,
      },
    ];

    if (existing && existing.messages.length) {
      history.length = 0;
      history.push({ role: 'system', content: system });
      for (const m of existing.messages.slice(-8)) {
        if (m.role === 'user' || m.role === 'assistant') {
          history.push({ role: m.role, content: m.content });
        }
      }
      history.push({ role: 'user', content: userText });
    }

    const startedAt = Date.now();
    const userMsg: CaseSessionMessage = { role: 'user', content: userText, time: startedAt };
    const assistantMsg: CaseSessionMessage = {
      role: 'assistant',
      content: '',
      time: startedAt,
      result: { ok: false, count: 0 },
    };
    const nextMessages = [...(sess.messages || []), userMsg, assistantMsg];
    const initialTitle =
      sess.messages.length > 0 ? sess.title : docTitleHint || userText.slice(0, 24) || sess.title;
    sess = {
      ...sess,
      messages: nextMessages,
      title: initialTitle,
    };
    setSession(sess);
    updateCaseSession(sess.id, { messages: nextMessages, title: sess.title });

    setStreaming(true);
    setError(null);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let full = '';

    function commitAssistant(result: CaseGenResultMeta, raw = '') {
      const msgs = [...nextMessages];
      msgs[msgs.length - 1] = {
        role: 'assistant',
        content: raw,
        time: Date.now(),
        result,
      };
      const patch: Partial<CaseSession> = {
        messages: msgs,
        outputFormat: sess!.outputFormat,
        caseType: sess!.caseType,
      };
      if (result.ok && result.path) {
        patch.linkedCasePath = result.path;
        if (result.path) setSavedFile({ path: result.path, count: result.count });
      }
      const updated = updateCaseSession(sess!.id, patch);
      setSession(updated.sessions.find((s) => s.id === sess!.id) ?? null);
    }

    try {
      for await (const chunk of streamChat(settings, history, ctrl.signal, { thinking: false })) {
        if (chunk.type === 'content') {
          full += chunk.delta;
        }
      }
      const durationMs = Date.now() - startedAt;
      const payload = extractJsonPayload(full);
      if (!payload) {
        const err = '未能解析出用例 JSON';
        setError(`${err}，可调整提示词或需求后重试。`);
        commitAssistant({
          ok: false,
          count: 0,
          durationMs,
          finishedAt: Date.now(),
          error: err,
          omissions: ['输出无法解析，未写入用例文件'],
        });
      } else {
        const fields = template?.headers?.length ? template.headers : [...CASE_FIELDS];
        const cases = normalizeCaseRows(payload.cases, fields);
        const finalTitle =
          payload.docTitle || docTitleHint || sess.title || caseTypeMeta(sess.caseType).label;
        const path = await persistCasesToLibrary(
          cases,
          { ...sess, title: finalTitle },
          finalTitle,
          fields,
        );
        const omissions = detectOmissions(cases, fields);
        updateCaseSession(sess.id, { title: finalTitle });
        commitAssistant({
          ok: true,
          count: cases.length,
          path,
          durationMs,
          finishedAt: Date.now(),
          omissions,
        });
      }
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        commitAssistant({
          ok: false,
          count: 0,
          durationMs: Date.now() - startedAt,
          finishedAt: Date.now(),
          error: msg,
          omissions: ['生成过程中断或失败'],
        });
      } else {
        commitAssistant({
          ok: false,
          count: 0,
          durationMs: Date.now() - startedAt,
          finishedAt: Date.now(),
          error: '已停止',
          omissions: ['用户停止生成'],
        });
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  async function onSubmit() {
    const text = input.trim();
    if (!text || streaming) return;
    setInput('');
    await runGenerate(text, session ?? undefined);
  }

  const canSend = Boolean(input.trim()) && !streaming;
  const reqOptions = reqFiles.map((f) => ({ value: f.path, label: f.path }));
  const templateOptions = templates.map((t) => ({ value: t.id, label: t.title }));
  const promptOptions = promptFiles.map((f) => ({
    value: f.path,
    label: f.path.replace(/\.[^.]+$/, ''),
  }));

  return (
    <div className="flex flex-col gap-4 max-w-4xl mx-auto">
      {!docsLive ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          本地文档服务未就绪，无法读写需求 / 模板 / 提示词 / 用例库。
        </div>
      ) : null}

      <section className="rounded-xl border border-stone-200 bg-white p-4 space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <div className="text-xs font-medium text-stone-500">用例类型</div>
            <SelectDropdown
              options={listCaseTypes().map((o) => ({ value: o.id, label: o.label }))}
              value={activeType}
              onChange={(v) => {
                setCaseType(v);
                patchSession({ caseType: v });
              }}
            />
          </div>
          <div>
            <div className="text-xs font-medium text-stone-500">输出格式</div>
            <SelectDropdown
              options={FORMAT_OPTS}
              value={outputFormat}
              onChange={(fmt) => {
                setOutputFormat(fmt);
                // 改格式后下次生成写新扩展名；已关联路径则同步扩展名
                if (session?.linkedCasePath) {
                  const base = session.linkedCasePath.replace(/\.[^.]+$/, '');
                  const ext = fmt === 'md' ? '.md' : fmt === 'csv' ? '.csv' : '.xlsx';
                  const nextPath = `${base}${ext}`;
                  patchSession({ outputFormat: fmt, linkedCasePath: nextPath });
                  setSavedFile((prev) =>
                    prev ? { ...prev, path: nextPath } : { path: nextPath, count: 0 },
                  );
                } else {
                  patchSession({ outputFormat: fmt });
                }
              }}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <div className="text-xs font-medium text-stone-500 mb-0.5">需求文档</div>
            <SearchableSelect
              options={reqOptions}
              value={selectedReq}
              onChange={(v) => {
                setSelectedReq(v);
                patchSession({ reqPaths: v ? [v] : [] });
              }}
              allowEmpty={false}
              placeholder="未选择需求文档"
            />
          </div>
          <div>
            <div className="text-xs font-medium text-stone-500 mb-0.5">
              用例模板
              <span className="ml-1 font-normal text-stone-400">
                （{typeLabel} · {caseTypeMeta(activeType).templateFolder}）
              </span>
            </div>
            <SearchableSelect
              options={templateOptions}
              value={template?.id ?? ''}
              onChange={(v) => {
                setTemplateId(v);
                const t = templates.find((x) => x.id === v);
                patchSession({ templateId: v, templateTitle: t?.title });
              }}
              allowEmpty={false}
              placeholder={
                templateOptions.length
                  ? '搜索并选择模板…'
                  : `暂无「${caseTypeMeta(activeType).templateFolder}」模板`
              }
            />
            {template?.headers?.length ? (
              <ExcelFieldTags fields={template.headers} />
            ) : template ? (
              <p className="mt-1.5 text-[11px] text-stone-400">未识别到模板字段</p>
            ) : null}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <div className="text-xs font-medium text-stone-500 mb-0.5">提示词</div>
            <SearchableSelect
              options={promptOptions}
              value={promptPath}
              onChange={(v) => {
                setPromptPath(v);
                patchSession({ promptPath: v || undefined });
              }}
              allowEmpty={false}
              placeholder={promptOptions.length ? '搜索并选择提示词…' : '请先在提示词管理中上传'}
            />
          </div>
          <div>
            <div className="text-xs font-medium text-stone-500 mb-0.5">引用知识库（可多选）</div>
            <MultiSelectDropdown
              options={knowledgeFiles.map((f) => ({
                value: f.path,
                label: f.path.replace(/\.[^.]+$/, ''),
              }))}
              values={knowledgePaths}
              onChange={(v) => {
                setKnowledgePaths(v);
                patchSession({ knowledgePaths: v.length ? v : undefined });
              }}
              placeholder={knowledgeFiles.length ? '选择知识库文档…' : '暂无知识库文档'}
            />
          </div>
        </div>

        {session?.linkedCasePath && !savedFile ? (
          <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-md px-3 py-2">
            已关联用例文件：{docRootLabelPath('cases')}
            {session.linkedCasePath}
          </p>
        ) : null}
      </section>

      <section className="rounded-xl border border-stone-200 bg-[#f8f9fb] flex flex-col h-[min(520px,60vh)]">
        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-3">
          {!session?.messages.length ? (
            <div className="h-full flex items-center justify-center text-sm text-stone-400 py-16">
              选择上下文后，在下方输入需求说明并提交，将创建一条用例会话。
            </div>
          ) : (
            (() => {
              const turns: Array<{ user?: CaseSessionMessage; assistant?: CaseSessionMessage }> =
                [];
              for (const m of session.messages) {
                if (m.role === 'user') turns.push({ user: m });
                else if (m.role === 'assistant') {
                  const last = turns[turns.length - 1];
                  if (last && !last.assistant) last.assistant = m;
                  else turns.push({ assistant: m });
                }
              }
              return turns.map((turn, i) => {
                const isLast = i === turns.length - 1;
                const pending = streaming && isLast && !turn.assistant?.result?.finishedAt;
                const result = turn.assistant?.result;
                return (
                  <div key={i} className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-stretch">
                    <div className="rounded-xl border border-stone-200 bg-white px-3 py-3 min-h-22">
                      <div className="text-[11px] font-medium text-stone-400 mb-1.5">提问</div>
                      <div className="text-sm text-stone-800 whitespace-pre-wrap leading-6">
                        {turn.user?.content || '—'}
                      </div>
                    </div>
                    <div className="rounded-xl border border-stone-200 bg-white px-3 py-3 min-h-22">
                      <div className="text-[11px] font-medium text-stone-400 mb-1.5">生成结果</div>
                      {pending ? (
                        <div className="text-sm text-[#4176e6]">生成中…</div>
                      ) : result ? (
                        <div className="space-y-2 text-sm">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span
                              className={`inline-flex items-center h-6 px-2 rounded-md text-xs font-medium ${
                                result.ok
                                  ? 'bg-emerald-50 text-emerald-700'
                                  : 'bg-red-50 text-red-700'
                              }`}
                            >
                              {result.ok ? '成功' : '失败'}
                            </span>
                            <span className="text-xs text-stone-500">
                              {formatClock(result.finishedAt ?? turn.assistant?.time)}
                            </span>
                            <span className="text-xs text-stone-500">
                              耗时 {formatDuration(result.durationMs)}
                            </span>
                          </div>
                          <div className="text-stone-700">
                            用例数量：
                            <span className="font-medium text-stone-900">{result.count}</span> 条
                          </div>
                          {result.path ? (
                            <button
                              type="button"
                              className="text-xs text-[#4176e6] hover:underline text-left truncate max-w-full"
                              data-hint="本地打开"
                              onClick={() =>
                                void openDocsFile('cases', result.path!).catch((e) =>
                                  setError(e instanceof Error ? e.message : String(e)),
                                )
                              }
                            >
                              {docRootLabelPath('cases')}
                              {result.path}
                            </button>
                          ) : null}
                          {result.error ? (
                            <div className="text-xs text-red-600">{result.error}</div>
                          ) : null}
                          <div>
                            <div className="text-xs font-medium text-stone-500 mb-1">遗漏检测</div>
                            {result.omissions && result.omissions.length > 0 ? (
                              <ul className="text-xs text-amber-800 bg-amber-50 border border-amber-100 rounded-md px-2.5 py-2 space-y-1">
                                {result.omissions.map((t) => (
                                  <li key={t}>· {t}</li>
                                ))}
                              </ul>
                            ) : result.ok ? (
                              <div className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-md px-2.5 py-2">
                                未发现明显遗漏
                              </div>
                            ) : (
                              <div className="text-xs text-stone-400">—</div>
                            )}
                          </div>
                        </div>
                      ) : (
                        <div className="text-sm text-stone-400">等待结果</div>
                      )}
                    </div>
                  </div>
                );
              });
            })()
          )}
          <div ref={bottomRef} />
        </div>

        {error ? (
          <div className="shrink-0 mx-4 mb-2 px-3 py-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg">
            {error}
          </div>
        ) : null}

        {savedFile ? (
          <div className="shrink-0 mx-4 mb-3">
            <div className="text-xs font-medium text-stone-500 mb-1.5">生成的用例文件</div>
            <button
              type="button"
              data-hint="点击在本地打开"
              onClick={() => {
                void openDocsFile('cases', savedFile.path).catch((e) =>
                  setError(e instanceof Error ? e.message : String(e)),
                );
              }}
              onDoubleClick={() => {
                void openDocsFile('cases', savedFile.path).catch((e) =>
                  setError(e instanceof Error ? e.message : String(e)),
                );
              }}
              className="w-full flex items-center gap-3 rounded-lg border border-stone-200 bg-white px-3 py-2.5 text-left hover:border-[#4176e6] hover:bg-[#f5f8ff] transition-colors"
            >
              <span className="w-9 h-9 rounded-lg bg-emerald-50 text-emerald-700 flex items-center justify-center text-xs font-semibold shrink-0">
                {savedFile.path.split('.').pop()?.toUpperCase() || 'FILE'}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm text-stone-800 truncate">
                  {savedFile.path.split('/').pop()}
                </span>
                <span className="block text-[11px] text-stone-400 truncate">
                  {docRootLabelPath('cases')}
                  {savedFile.path}
                  {savedFile.count > 0 ? ` · ${savedFile.count} 条` : ''}
                  {' · 点击打开'}
                </span>
              </span>
            </button>
          </div>
        ) : null}

        <div className="shrink-0 p-3 border-t border-stone-200 bg-white rounded-b-xl">
          <div className="rounded-2xl border border-stone-200 focus-within:ring-2 focus-within:ring-[#4176e6]/25">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              rows={3}
              placeholder={
                settings ? '描述要生成或修改的用例… Enter 发送，Shift+Enter 换行' : '请先配置模型'
              }
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void onSubmit();
                }
              }}
              className="w-full px-4 pt-3 pb-2 text-sm resize-none outline-none bg-transparent"
            />
            <div className="flex items-center justify-end gap-2 px-3 pb-2">
              {!settings ? (
                <button
                  type="button"
                  onClick={() => openSettings('model')}
                  className="text-xs text-amber-700 hover:underline"
                >
                  配置模型
                </button>
              ) : null}
              {streaming ? (
                <button
                  type="button"
                  onClick={() => abortRef.current?.abort()}
                  className="h-8 px-3 text-sm rounded-full bg-stone-200 text-stone-700"
                >
                  停止
                </button>
              ) : null}
              <button
                type="button"
                disabled={!canSend}
                onClick={() => void onSubmit()}
                className="h-8 px-4 text-sm font-medium text-white bg-[#4176e6] rounded-full hover:bg-[#3565c7] disabled:opacity-40"
              >
                提交
              </button>
            </div>
          </div>
          {session ? (
            <button
              type="button"
              className="mt-2 text-xs text-stone-400 hover:text-stone-600"
              onClick={() => {
                setSession(null);
                setSavedFile(null);
                setError(null);
                const store = loadCaseSessions();
                saveCaseSessions({ ...store, activeId: '' });
              }}
            >
              开始新的用例会话
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}

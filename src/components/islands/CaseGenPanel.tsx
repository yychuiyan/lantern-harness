/**
 * AI 工作台「用例生成」插件面板：仅配置规则，确认后交由主会话发送时使用。
 */
import { useEffect, useMemo, useState } from 'react';
import type { CaseGenPluginConfig } from '../../lib/case-gen-config';
import {
  parseCsvTemplate,
  parseMdTemplate,
  parseXlsxTemplateBase64,
} from '../../lib/case-template';
import type { CaseOutputFormat } from '../../lib/case-sessions';
import {
  addCaseType,
  caseTypeMeta,
  listCaseTypes,
  removeCaseType,
  updateCaseType,
  type CaseType,
  type CaseTypeDef,
} from '../../lib/case-types';
import { CASE_FIELDS } from '../../lib/export';
import { hydrateAppConfig } from '../../lib/app-config';
import { isPluginEnabled, onPluginEnabledChanged } from '../../lib/plugins';
import { isChatOnlyPrompt } from '../../lib/prompts-meta';
import {
  fetchDocsHealth,
  listDocs,
  readDocsRaw,
  readDocsText,
  type DocsEntry,
} from '../../lib/project-docs';
import ExcelFieldTags from './ExcelFieldTags';
import MultiSelectDropdown from './MultiSelectDropdown';
import SearchableSelect from './SearchableSelect';
import SelectDropdown from './SelectDropdown';
import { showToast } from './Toast';
import SlideOverDrawer from './SlideOverDrawer';

interface TemplateOpt {
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

async function loadTemplatesForType(
  caseType: CaseType,
  types: CaseTypeDef[],
): Promise<TemplateOpt[]> {
  const folder =
    types.find((t) => t.id === caseType)?.templateFolder ?? caseTypeMeta(caseType).templateFolder;
  try {
    const { entries } = await listDocs('templates', folder);
    const files = entries
      .filter((e) => e.type === 'file')
      .sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
    const out: TemplateOpt[] = [];
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
  return '';
}

interface Props {
  open: boolean;
  onClose: () => void;
  initial?: CaseGenPluginConfig | null;
  onConfirm: (cfg: CaseGenPluginConfig) => void;
}

export default function CaseGenPanel({ open, onClose, initial, onConfirm }: Props) {
  const [docsLive, setDocsLive] = useState(false);
  const [reqFiles, setReqFiles] = useState<DocsEntry[]>([]);
  const [selectedReq, setSelectedReq] = useState(initial?.reqPath ?? '');
  const [caseTypes, setCaseTypes] = useState<CaseTypeDef[]>(() => listCaseTypes());
  const [caseType, setCaseType] = useState<CaseType>(
    initial?.caseType ?? listCaseTypes()[0]?.id ?? 'functional',
  );
  const [templates, setTemplates] = useState<TemplateOpt[]>([]);
  const [templateId, setTemplateId] = useState(initial?.templateId ?? '');
  const [promptFiles, setPromptFiles] = useState<DocsEntry[]>([]);
  const [promptPath, setPromptPath] = useState(initial?.promptPath ?? '');
  const [promptBody, setPromptBody] = useState(initial?.promptBody ?? '');
  const [knowledgeFiles, setKnowledgeFiles] = useState<DocsEntry[]>([]);
  const [knowledgePaths, setKnowledgePaths] = useState<string[]>(initial?.knowledgePaths ?? []);
  const [outputFormat, setOutputFormat] = useState<CaseOutputFormat>(
    initial?.outputFormat ?? 'xlsx',
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [typeEditor, setTypeEditor] = useState<'add' | 'edit' | null>(null);
  const [typeDraft, setTypeDraft] = useState('');
  const [deleteTypePending, setDeleteTypePending] = useState(false);
  const [promptsOn, setPromptsOn] = useState(() => isPluginEnabled('prompts'));
  const [knowledgeLibOn, setKnowledgeLibOn] = useState(() => isPluginEnabled('knowledgeLib'));
  const [requirementsOn, setRequirementsOn] = useState(() => isPluginEnabled('requirements'));
  const [templatesOn, setTemplatesOn] = useState(() => isPluginEnabled('templates'));

  const template = useMemo(
    () => templates.find((t) => t.id === templateId) ?? templates[0],
    [templates, templateId],
  );
  const activeTypeDef =
    caseTypes.find((t) => t.id === caseType) ?? caseTypes[0] ?? caseTypeMeta(caseType);
  const typeLabel = activeTypeDef.label;

  function refreshTypes(preferId?: string) {
    const list = listCaseTypes();
    setCaseTypes(list);
    setCaseType((prev) => {
      const want = preferId ?? prev;
      if (list.some((x) => x.id === want)) return want;
      return list[0]?.id ?? prev;
    });
  }

  function saveTypeDraft() {
    try {
      if (typeEditor === 'add') {
        const def = addCaseType(typeDraft);
        refreshTypes(def.id);
      } else if (typeEditor === 'edit') {
        updateCaseType(caseType, typeDraft);
        refreshTypes(caseType);
      }
      setTypeEditor(null);
      setTypeDraft('');
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    const apply = () => {
      setPromptsOn(isPluginEnabled('prompts'));
      setKnowledgeLibOn(isPluginEnabled('knowledgeLib'));
      setRequirementsOn(isPluginEnabled('requirements'));
      setTemplatesOn(isPluginEnabled('templates'));
    };
    const off = onPluginEnabledChanged(() => apply());
    void hydrateAppConfig().then(apply);
    return off;
  }, []);

  useEffect(() => {
    if (!open) return;
    // 同会话再次打开：回填上次确认配置
    refreshTypes(initial?.caseType);
    setSelectedReq(initial?.reqPath ?? '');
    setCaseType(initial?.caseType ?? listCaseTypes()[0]?.id ?? 'functional');
    setTemplateId(initial?.templateId ?? '');
    setPromptPath(initial?.promptPath ?? '');
    setPromptBody(initial?.promptBody ?? '');
    setKnowledgePaths(initial?.knowledgePaths ?? []);
    setOutputFormat(initial?.outputFormat ?? 'xlsx');
    setTypeEditor(null);
    setTypeDraft('');
    setDeleteTypePending(false);
    setError(null);
    void (async () => {
      const ok =
        (await fetchDocsHealth('templates')) &&
        (await fetchDocsHealth('prompts')) &&
        (await fetchDocsHealth('requirements')) &&
        (await fetchDocsHealth('knowledge'));
      setDocsLive(ok);
      if (!ok) return;
      async function walk(
        root: 'requirements' | 'prompts' | 'knowledge',
        dir: string,
        acc: DocsEntry[],
      ) {
        const { entries } = await listDocs(root, dir);
        for (const e of entries) {
          if (e.type === 'file') acc.push(e);
          else await walk(root, e.path, acc);
        }
      }
      if (!requirementsOn) {
        setReqFiles([]);
        setSelectedReq('');
      } else {
        try {
          const reqs: DocsEntry[] = [];
          await walk('requirements', '.', reqs);
          setReqFiles(reqs);
          setSelectedReq((prev) => (prev && reqs.some((f) => f.path === prev) ? prev : ''));
        } catch {
          // ignore
        }
      }
      if (!knowledgeLibOn) {
        setKnowledgeFiles([]);
        setKnowledgePaths([]);
      } else {
        try {
          const kbs: DocsEntry[] = [];
          await walk('knowledge', '.', kbs);
          kbs.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
          setKnowledgeFiles(kbs);
          setKnowledgePaths((prev) => prev.filter((p) => kbs.some((f) => f.path === p)));
        } catch {
          // ignore
        }
      }
      if (!promptsOn) {
        setPromptFiles([]);
        setPromptPath('');
        setPromptBody('');
      } else {
        try {
          const prompts: DocsEntry[] = [];
          await walk('prompts', '.', prompts);
          const casePrompts = prompts.filter((f) => !isChatOnlyPrompt(f.path));
          casePrompts.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
          setPromptFiles(casePrompts);
          setPromptPath((prev) => {
            if (prev && casePrompts.some((x) => x.path === prev)) return prev;
            if (initial?.promptPath && casePrompts.some((x) => x.path === initial.promptPath)) {
              return initial.promptPath;
            }
            return (
              casePrompts.find((f) => f.path.includes('功能测试用例提示词'))?.path ??
              casePrompts[0]?.path ??
              ''
            );
          });
        } catch {
          // ignore
        }
      }
    })();
  }, [open, initial, promptsOn, knowledgeLibOn, requirementsOn]);

  useEffect(() => {
    if (!open || !docsLive) return;
    if (!templatesOn) {
      setTemplates([]);
      setTemplateId('');
      return;
    }
    let cancelled = false;
    void loadTemplatesForType(caseType, caseTypes).then((list) => {
      if (cancelled) return;
      setTemplates(list);
      setTemplateId((prev) => {
        if (prev && list.some((x) => x.id === prev)) return prev;
        if (initial?.templateId && list.some((x) => x.id === initial.templateId)) {
          return initial.templateId;
        }
        return list[0]?.id ?? '';
      });
    });
    return () => {
      cancelled = true;
    };
  }, [open, docsLive, templatesOn, caseType, caseTypes, initial?.templateId]);

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

  const reqOptions = reqFiles.map((f) => ({ value: f.path, label: f.path }));
  const templateOptions = templates.map((t) => ({ value: t.id, label: t.title }));
  const promptOptions = promptFiles.map((f) => ({
    value: f.path,
    label: f.path.replace(/\.[^.]+$/, ''),
  }));
  const knowledgeOptions = knowledgeFiles.map((f) => ({
    value: f.path,
    label: f.path.replace(/\.[^.]+$/, ''),
  }));

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      if (!promptsOn) {
        setError('请先在「我的插件」中启用「提示词管理」');
        return;
      }
      if (!promptPath || !promptBody.trim()) {
        const message = '请先选择用例生成提示词（不再使用「默认提示词」或工作台系统提示词）';
        setError(message);
        showToast(message, 'error');
        return;
      }
      const tpl = templates.find((t) => t.id === templateId) ?? templates[0];
      let reqSnippet = '';
      if (selectedReq) {
        try {
          const full = await readRequirementText(selectedReq);
          reqSnippet = full.slice(0, 12000);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
          return;
        }
      }
      const kbParts: string[] = [];
      for (const kp of knowledgePaths) {
        try {
          const r = await readDocsText('knowledge', kp);
          kbParts.push(`\n### 知识库：${kp}\n${r.content.slice(0, 6000)}`);
        } catch {
          kbParts.push(`\n### 知识库：${kp}\n（无法读取）`);
        }
      }
      const cfg: CaseGenPluginConfig = {
        active: true,
        caseType,
        outputFormat,
        reqPath: selectedReq || undefined,
        templateId: tpl?.id,
        templateTitle: tpl?.title,
        promptPath,
        knowledgePaths: knowledgePaths.length ? [...knowledgePaths] : undefined,
        templateHeaders: tpl?.headers?.length ? tpl.headers : [...CASE_FIELDS],
        templateBody: [
          tpl?.body || '',
          reqSnippet ? `\n### 需求文档：${selectedReq}\n${reqSnippet}` : '',
          ...kbParts,
        ]
          .join('')
          .trim(),
        promptBody: promptBody.trim(),
        confirmedAt: Date.now(),
        linkedCasePath: initial?.linkedCasePath,
      };
      onConfirm(cfg);
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <SlideOverDrawer
      open={open}
      onClose={onClose}
      title="生成测试用例 · 配置"
      closeAriaLabel="关闭生成测试用例面板"
      footer={
        <footer className="shrink-0 p-4 border-t border-stone-100 flex items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-9 px-3 text-sm text-stone-600 rounded-lg hover:bg-stone-100"
          >
            取消
          </button>
          <button
            type="button"
            disabled={busy || !docsLive || !promptsOn || !promptPath}
            onClick={() => void confirm()}
            className="flex-1 h-9 text-sm font-medium text-white bg-[#4176e6] rounded-lg hover:bg-[#3565c7] disabled:opacity-40"
          >
            确认
          </button>
        </footer>
      }
    >
      {!docsLive ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          本地文档服务未就绪，无法读写文档库。
        </div>
      ) : null}

      <p className="text-xs text-stone-500 leading-5">
        按所选用例类型、模板与提示词生成可入库用例：确认后在主输入框描述需求并发送，输出结构化用例并写入用例库，可在「用例管理」中查看。
      </p>

      {error ? (
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          {error}
        </div>
      ) : null}

      <div>
        <div className="flex items-center gap-2 mb-1">
          <div className="text-xs font-medium text-stone-500 flex-1">用例类型</div>
          <button
            type="button"
            className="text-[11px] text-[#4176e6] hover:underline"
            onClick={() => {
              setTypeEditor('add');
              setTypeDraft('');
              setError(null);
              setDeleteTypePending(false);
            }}
          >
            新增
          </button>
          <button
            type="button"
            className="text-[11px] text-stone-600 hover:underline"
            onClick={() => {
              setTypeEditor('edit');
              setTypeDraft(activeTypeDef.label);
              setError(null);
              setDeleteTypePending(false);
            }}
          >
            编辑
          </button>
          {deleteTypePending ? (
            <>
              <span className="text-[11px] text-stone-500 shrink-0">确认删除？</span>
              <button
                type="button"
                className="text-[11px] text-red-600 hover:underline shrink-0"
                onClick={() => {
                  setDeleteTypePending(false);
                  try {
                    const next = removeCaseType(caseType);
                    setCaseTypes(next);
                    setCaseType(next[0]?.id ?? '');
                    setTypeEditor(null);
                    setError(null);
                  } catch (e) {
                    setError(e instanceof Error ? e.message : String(e));
                  }
                }}
              >
                确认
              </button>
              <button
                type="button"
                className="text-[11px] text-stone-500 hover:underline shrink-0"
                onClick={() => setDeleteTypePending(false)}
              >
                取消
              </button>
            </>
          ) : (
            <button
              type="button"
              className="text-[11px] text-red-600 hover:underline disabled:opacity-40"
              disabled={caseTypes.length <= 1}
              onClick={() => {
                setTypeEditor(null);
                setDeleteTypePending(true);
                setError(null);
              }}
            >
              删除
            </button>
          )}
        </div>
        <SelectDropdown
          options={caseTypes.map((o) => ({ value: o.id, label: o.label }))}
          value={caseType}
          onChange={(v) => {
            setCaseType(v);
            setDeleteTypePending(false);
          }}
        />
        {typeEditor ? (
          <div className="mt-2 rounded-lg border border-stone-200 bg-stone-50 p-2 space-y-2">
            <label className="text-[11px] text-stone-500" htmlFor="cg-type-draft">
              {typeEditor === 'add' ? '新类型名称' : '修改名称'}
            </label>
            <input
              id="cg-type-draft"
              value={typeDraft}
              onChange={(e) => setTypeDraft(e.target.value)}
              placeholder="如：安全测试"
              className="w-full h-8 px-2 text-sm rounded-md border border-stone-200 bg-white focus:outline-none focus:ring-2 focus:ring-[#4176e6]/40"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  saveTypeDraft();
                }
              }}
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="h-7 px-2.5 text-xs font-medium text-white bg-[#4176e6] rounded-md hover:bg-[#3565c7]"
                onClick={saveTypeDraft}
              >
                保存
              </button>
              <button
                type="button"
                className="h-7 px-2.5 text-xs text-stone-600 rounded-md hover:bg-stone-200/80"
                onClick={() => {
                  setTypeEditor(null);
                  setTypeDraft('');
                }}
              >
                取消
              </button>
            </div>
            <p className="text-[10px] text-stone-400 leading-4">
              模板目录约定为「名称 + 用例」，如「安全测试」→ 测试模板库/安全测试用例/
            </p>
          </div>
        ) : null}
      </div>
      <div>
        <div className="text-xs font-medium text-stone-500">输出格式</div>
        <SelectDropdown options={FORMAT_OPTS} value={outputFormat} onChange={setOutputFormat} />
      </div>
      <div>
        <div className="text-xs font-medium text-stone-500 mb-0.5">需求文档</div>
        <SearchableSelect
          options={reqOptions}
          value={selectedReq}
          onChange={setSelectedReq}
          allowEmpty={false}
          disabled={!requirementsOn}
          placeholder={
            !requirementsOn
              ? '需求文档库未启用'
              : reqOptions.length
                ? '搜索并选择需求文档…'
                : '请先在需求文档库中上传'
          }
        />
        {!requirementsOn ? (
          <p className="mt-1 text-[11px] text-stone-400">
            请先在「我的插件」中启用「需求文档库」后再选择。
          </p>
        ) : null}
      </div>
      <div>
        <div className="text-xs font-medium text-stone-500 mb-0.5">
          用例模板
          <span className="ml-1 font-normal text-stone-400">
            （{typeLabel} · {activeTypeDef.templateFolder}）
          </span>
        </div>
        <SearchableSelect
          options={templateOptions}
          value={template?.id ?? ''}
          onChange={setTemplateId}
          allowEmpty={false}
          disabled={!templatesOn}
          placeholder={
            !templatesOn
              ? '测试模板库未启用'
              : templateOptions.length
                ? '搜索并选择模板…'
                : `暂无「${activeTypeDef.templateFolder}」模板`
          }
        />
        {!templatesOn ? (
          <p className="mt-1 text-[11px] text-stone-400">
            请先在「我的插件」中启用「测试模板库」后再选择；未启用时按默认字段生成。
          </p>
        ) : null}
        {template?.headers?.length ? <ExcelFieldTags fields={template.headers} /> : null}
      </div>
      <div>
        <div className="text-xs font-medium text-stone-500 mb-0.5">提示词</div>
        <SearchableSelect
          options={promptOptions}
          value={promptPath}
          onChange={setPromptPath}
          allowEmpty={false}
          disabled={!promptsOn}
          placeholder={
            !promptsOn
              ? '提示词管理未启用'
              : promptOptions.length
                ? '搜索并选择提示词…'
                : '请先在提示词管理中上传'
          }
        />
        <p className="mt-1 text-[11px] text-stone-400">
          {!promptsOn
            ? '请先在「我的插件」中启用「提示词管理」后再选择。'
            : '启用后主会话将只使用该提示词，不再叠加「系统提示词」。'}
        </p>
      </div>
      <div>
        <div className="text-xs font-medium text-stone-500 mb-0.5">引用知识库（可多选）</div>
        <MultiSelectDropdown
          options={knowledgeOptions}
          values={knowledgePaths}
          onChange={setKnowledgePaths}
          disabled={!knowledgeLibOn}
          placeholder={
            !knowledgeLibOn
              ? '知识库管理未启用'
              : knowledgeOptions.length
                ? '选择知识库文档…'
                : '暂无知识库文档'
          }
        />
        {!knowledgeLibOn ? (
          <p className="mt-1 text-[11px] text-stone-400">
            请先在「我的插件」中启用「知识库管理」后再引用。
          </p>
        ) : null}
      </div>
    </SlideOverDrawer>
  );
}

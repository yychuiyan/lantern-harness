/**
 * AI 工作台「用例生成」插件面板：仅配置规则，确认后交由主会话发送时使用。
 */
import { useEffect, useMemo, useState } from 'react';
import type { CaseGenPluginConfig, CaseGenReqSource } from '../../lib/case-gen-config';
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
import {
  fetchReqAnalysisHealth,
  listReqDocs,
  storiesToMarkdown,
  type ReqAnalysisDoc,
} from '../../lib/req-analysis';
import ExcelFieldTags from './ExcelFieldTags';
import CaseTypeDialog, { type CaseTypeDialogMode } from './CaseTypeDialog';
import MultiSelectDropdown from './MultiSelectDropdown';
import OverflowHint from './OverflowHint';
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
  /** 从需求分析「用选中故事生成用例」带过来的预选（一次性） */
  presetStories?: { docId: string; storyIds: string[] } | null;
  onConfirm: (cfg: CaseGenPluginConfig) => void;
}

export default function CaseGenPanel({ open, onClose, initial, presetStories, onConfirm }: Props) {
  const [docsLive, setDocsLive] = useState(false);
  const [reqFiles, setReqFiles] = useState<DocsEntry[]>([]);
  const [selectedReq, setSelectedReq] = useState(initial?.reqPath ?? '');
  /** 需求来源：需求文档库 / 需求分析的用户故事 */
  const [reqMode, setReqMode] = useState<'doc' | 'stories'>(
    initial?.reqSource?.kind === 'stories' ? 'stories' : 'doc',
  );
  const [reqDocs, setReqDocs] = useState<ReqAnalysisDoc[]>([]);
  const [storiesLive, setStoriesLive] = useState(false);
  const [storyDocId, setStoryDocId] = useState(
    initial?.reqSource?.kind === 'stories' ? initial.reqSource.docId : '',
  );
  const [storyIds, setStoryIds] = useState<string[]>(
    initial?.reqSource?.kind === 'stories' ? initial.reqSource.storyIds : [],
  );
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
  const [typeEditor, setTypeEditor] = useState<CaseTypeDialogMode | null>(null);
  /** 弹窗内校验错误（重名 / 名称为空），弹窗不关就地提示 */
  const [typeError, setTypeError] = useState<string | null>(null);
  const [promptsOn, setPromptsOn] = useState(() => isPluginEnabled('prompts'));
  const [knowledgeLibOn, setKnowledgeLibOn] = useState(() => isPluginEnabled('knowledgeLib'));
  const [requirementsOn, setRequirementsOn] = useState(() => isPluginEnabled('requirements'));
  const [templatesOn, setTemplatesOn] = useState(() => isPluginEnabled('templates'));
  const [reqAnalysisOn, setReqAnalysisOn] = useState(() => isPluginEnabled('reqAnalysis'));

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

  function saveCaseType(name: string) {
    try {
      if (typeEditor === 'add') {
        const def = addCaseType(name);
        refreshTypes(def.id);
      } else if (typeEditor === 'edit') {
        updateCaseType(caseType, name);
        refreshTypes(caseType);
      }
      setTypeEditor(null);
      setTypeError(null);
    } catch (e) {
      // 弹窗不关，就地提示重名/名称非法
      setTypeError(e instanceof Error ? e.message : String(e));
    }
  }

  function deleteCaseType() {
    try {
      const next = removeCaseType(caseType);
      setCaseTypes(next);
      setCaseType(next[0]?.id ?? '');
      setTypeEditor(null);
      setTypeError(null);
    } catch (e) {
      setTypeError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    const apply = () => {
      setPromptsOn(isPluginEnabled('prompts'));
      setKnowledgeLibOn(isPluginEnabled('knowledgeLib'));
      setRequirementsOn(isPluginEnabled('requirements'));
      setTemplatesOn(isPluginEnabled('templates'));
      setReqAnalysisOn(isPluginEnabled('reqAnalysis'));
    };
    const off = onPluginEnabledChanged(() => apply());
    void hydrateAppConfig().then(apply);
    return off;
  }, []);

  useEffect(() => {
    if (!open) return;
    // 同会话再次打开：回填上次确认配置
    refreshTypes(initial?.caseType);
    const initialSource = initial?.reqSource;
    const initialStoryMode = initialSource?.kind === 'stories';
    setReqMode(initialStoryMode ? 'stories' : 'doc');
    setSelectedReq(initialSource?.kind === 'doc' ? initialSource.path : (initial?.reqPath ?? ''));
    setStoryDocId(initialStoryMode ? initialSource.docId : '');
    setStoryIds(initialStoryMode ? initialSource.storyIds : []);
    setCaseType(initial?.caseType ?? listCaseTypes()[0]?.id ?? 'functional');
    setTemplateId(initial?.templateId ?? '');
    setPromptPath(initial?.promptPath ?? '');
    setPromptBody(initial?.promptBody ?? '');
    setKnowledgePaths(initial?.knowledgePaths ?? []);
    setOutputFormat(initial?.outputFormat ?? 'xlsx');
    setTypeEditor(null);
    setTypeError(null);
    setError(null);
    // 需求分析带过来的预选：默认全选该记录的全部故事（没带 storyIds 时）
    if (presetStories?.docId) {
      setReqMode('stories');
      setStoryDocId(presetStories.docId);
      setStoryIds(presetStories.storyIds);
    }
    void (async () => {
      // 模板 / 提示词是生成的硬依赖；需求与知识库按开关分别探测
      const tplOk = await fetchDocsHealth('templates');
      const promptOk = await fetchDocsHealth('prompts');
      const reqOk = await fetchDocsHealth('requirements');
      const kbOk = await fetchDocsHealth('knowledge');
      setDocsLive(tplOk && promptOk);
      // 用户故事来源：需求分析插件 + 本地服务
      let storyDocs: ReqAnalysisDoc[] = [];
      if (isPluginEnabled('reqAnalysis') && (await fetchReqAnalysisHealth())) {
        try {
          storyDocs = await listReqDocs();
          storyDocs.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
          setStoriesLive(true);
          setReqDocs(storyDocs);
        } catch {
          setStoriesLive(false);
        }
      } else {
        setStoriesLive(false);
      }
      if (presetStories?.docId) {
        const target = storyDocs.find((d) => d.id === presetStories.docId);
        if (target) {
          setStoryDocId(target.id);
          setStoryIds(
            presetStories.storyIds.length
              ? presetStories.storyIds
              : target.stories.map((s) => s.id),
          );
        }
      }
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
      if (!requirementsOn || !reqOk) {
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
      if (!knowledgeLibOn || !kbOk) {
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
  }, [open, initial, promptsOn, knowledgeLibOn, requirementsOn, presetStories]);

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

  const activeStoryDoc = useMemo(
    () => reqDocs.find((d) => d.id === storyDocId) ?? null,
    [reqDocs, storyDocId],
  );
  const activeStories = activeStoryDoc?.stories ?? [];
  const pickedStoryCount = storyIds.filter((id) =>
    activeStories.some((story) => story.id === id),
  ).length;

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
      const source: CaseGenReqSource | undefined =
        reqMode === 'stories'
          ? storyDocId
            ? { kind: 'stories', docId: storyDocId, storyIds }
            : undefined
          : selectedReq
            ? { kind: 'doc', path: selectedReq }
            : undefined;
      let docTitle = '';
      let reqBlock = '';
      if (source?.kind === 'doc') {
        docTitle =
          source.path
            .split('/')
            .pop()
            ?.replace(/\.[^.]+$/, '') ?? '';
        try {
          const full = await readRequirementText(source.path);
          reqBlock = `### 需求文档：${source.path}\n${full.slice(0, 16000)}`;
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
          return;
        }
      } else if (source?.kind === 'stories') {
        if (!storiesLive) {
          setError(
            reqAnalysisOn
              ? '需求分析服务未就绪，暂时读不到用户故事；可切回「需求文档」'
              : '需求分析插件未启用，读不到用户故事；可切回「需求文档」',
          );
          return;
        }
        if (!activeStoryDoc) {
          setError('所选需求分析记录已不存在，请重新选择');
          return;
        }
        if (!pickedStoryCount) {
          setError('请至少勾选一条用户故事，或点「全选」');
          return;
        }
        docTitle = activeStoryDoc.title;
        reqBlock = `### 用户故事：${activeStoryDoc.title}\n按 US 编号逐条覆盖：每条故事的验收标准与异常场景都要有对应用例。\n${storiesToMarkdown(activeStoryDoc, storyIds)}`;
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
        reqPath: source?.kind === 'doc' ? source.path : undefined,
        reqSource: source,
        docTitle: docTitle || undefined,
        reqBlock: [reqBlock, ...kbParts].filter(Boolean).join('\n\n') || undefined,
        templateId: tpl?.id,
        templateTitle: tpl?.title,
        promptPath,
        knowledgePaths: knowledgePaths.length ? [...knowledgePaths] : undefined,
        templateHeaders: tpl?.headers?.length ? tpl.headers : [...CASE_FIELDS],
        templateBody: (tpl?.body || '').trim(),
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
    <>
      <SlideOverDrawer
        open={open}
        onClose={onClose}
        title="生成测试用例 · 配置"
        closeAriaLabel="关闭生成测试用例面板"
        widthClass="max-w-3xl"
        escDisabled={typeEditor !== null}
        footer={
          <footer className="shrink-0 border-t border-stone-100 px-4 py-3 flex items-center gap-2">
            <p className="flex-1 min-w-0 truncate text-[11px] text-stone-400">
              配置仅对当前会话生效，可在输入区胶囊里再改
            </p>
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
              className="h-9 px-5 text-sm font-medium text-white bg-[#4176e6] rounded-lg hover:bg-[#3565c7] disabled:opacity-40"
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

        {error ? (
          <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            {error}
          </div>
        ) : null}

        {/* 第一行：用例类型 / 用例模板；第二行：类型维护 chip / 模板字段 chip
            两行共用同一个 grid，第二行才是左右两列同一排（DOM 顺序用 order 在窄屏还原成
            「字段 → 它的附属信息」），否则右侧 chip 多一层内边距就会和左侧按钮错开一行 */}
        <div className="grid grid-cols-1 gap-x-4 gap-y-1 lg:grid-cols-2">
          <div className="order-1 min-w-0">
            <div className="mb-1 text-xs font-medium text-stone-500">用例类型</div>
            <SelectDropdown
              options={caseTypes.map((o) => ({ value: o.id, label: o.label }))}
              value={caseType}
              onChange={setCaseType}
              dimWhenOpen
            />
          </div>

          <div className="order-3 min-w-0 lg:order-2">
            <div className="mb-1 text-xs font-medium text-stone-500">
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
          </div>

          {/* 类型维护：与右侧模板字段 chip 同款、同一排，靠列尾右对齐 */}
          <div className="order-2 flex min-w-0 items-start justify-end gap-1 pt-1.5 lg:order-3">
            <button
              type="button"
              className="inline-flex h-[23px] items-center rounded border border-stone-200 px-1.5 text-[11px] leading-none text-[#4176e6] transition-colors hover:border-[#4176e6]/40 hover:bg-[#edf3fe]"
              onClick={() => {
                setTypeError(null);
                setTypeEditor('add');
              }}
            >
              新增
            </button>
            <button
              type="button"
              className="inline-flex h-[23px] items-center rounded border border-stone-200 px-1.5 text-[11px] leading-none text-stone-600 transition-colors hover:border-stone-300 hover:bg-stone-50"
              onClick={() => {
                setTypeError(null);
                setTypeEditor('edit');
              }}
            >
              编辑
            </button>
            <button
              type="button"
              className="inline-flex h-[23px] items-center rounded border border-stone-200 px-1.5 text-[11px] leading-none text-red-600 transition-colors hover:border-red-300 hover:bg-red-50 disabled:opacity-40 disabled:hover:border-stone-200 disabled:hover:bg-transparent"
              disabled={caseTypes.length <= 1}
              onClick={() => {
                setTypeError(null);
                setTypeEditor('delete');
              }}
            >
              删除
            </button>
          </div>

          <div className="order-4 min-w-0 lg:order-4">
            {!templatesOn ? (
              <p className="mt-1 text-[11px] text-stone-400">
                请先在「我的插件」中启用「测试模板库」后再选择；未启用时按默认字段生成。
              </p>
            ) : template?.headers?.length ? (
              // ExcelFieldTags 自带 mt-1.5，与左侧按钮的 pt-1.5 一致，两边同一水平线
              <ExcelFieldTags fields={template.headers} />
            ) : null}
          </div>
        </div>

        {/* 第二行：输出格式 / 提示词，并排对齐 */}
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
          <div className="min-w-0">
            <div className="mb-1 text-xs font-medium text-stone-500">输出格式</div>
            <SelectDropdown
              options={FORMAT_OPTS}
              value={outputFormat}
              onChange={setOutputFormat}
              dimWhenOpen
            />
          </div>

          <div className="min-w-0">
            <div className="mb-1 text-xs font-medium text-stone-500">提示词</div>
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
        </div>

        {/* 需求来源：整行，文档与用户故事二选一 */}
        <section className="rounded-xl border border-stone-200 p-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="text-xs font-medium text-stone-500">需求来源</div>
            <div className="inline-flex rounded-lg border border-stone-200 bg-stone-50 p-0.5">
              <button
                type="button"
                onClick={() => setReqMode('doc')}
                className={`h-7 rounded-md px-2.5 text-xs transition-colors ${
                  reqMode === 'doc'
                    ? 'bg-white text-stone-900 shadow-sm'
                    : 'text-stone-500 hover:text-stone-700'
                }`}
              >
                需求文档
              </button>
              <button
                type="button"
                disabled={!storiesLive}
                onClick={() => {
                  if (!storiesLive) return;
                  setReqMode('stories');
                }}
                className={`h-7 rounded-md px-2.5 text-xs transition-colors disabled:opacity-40 ${
                  reqMode === 'stories'
                    ? 'bg-white text-stone-900 shadow-sm'
                    : 'text-stone-500 hover:text-stone-700'
                }`}
              >
                用户故事
              </button>
            </div>
            <p className="text-[11px] text-stone-400">
              {reqMode === 'stories'
                ? '来自「需求分析」拆好的故事：按 US 编号逐条覆盖，改动后重新生成即可'
                : '来自「需求文档库」的原始文档'}
            </p>
          </div>

          <div className="mt-2">
            {reqMode === 'stories' ? (
              <SearchableSelect
                options={reqDocs.map((d) => ({
                  value: d.id,
                  label: `${d.title}（${d.stories.length} 个故事）`,
                }))}
                value={storyDocId}
                onChange={(v) => {
                  setStoryDocId(v);
                  const target = reqDocs.find((d) => d.id === v);
                  setStoryIds(target?.stories.map((s) => s.id) ?? []);
                }}
                allowEmpty={false}
                disabled={!storiesLive}
                placeholder={
                  !reqAnalysisOn
                    ? '需求分析插件未启用'
                    : storiesLive
                      ? reqDocs.length
                        ? '搜索并选择需求分析记录…'
                        : '暂无需求分析记录，请先在「需求分析」拆解'
                      : '需求分析服务未就绪'
                }
              />
            ) : (
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
            )}
          </div>

          {reqMode === 'stories' ? (
            <div className="mt-2 rounded-lg bg-stone-50/80 p-2.5">
              <div className="flex items-center gap-2">
                <div className="flex-1 text-[11px] text-stone-500">
                  选择故事
                  <span className="ml-1 text-stone-400">
                    {pickedStoryCount}/{activeStories.length}
                  </span>
                </div>
                <button
                  type="button"
                  className="text-[11px] text-[#4176e6] hover:underline"
                  onClick={() => setStoryIds(activeStories.map((s) => s.id))}
                >
                  全选
                </button>
                <button
                  type="button"
                  className="text-[11px] text-stone-500 hover:underline"
                  onClick={() => setStoryIds([])}
                >
                  全不选
                </button>
              </div>
              {activeStories.length ? (
                <div className="mt-1.5 grid max-h-56 grid-cols-1 gap-x-4 overflow-y-auto sm:grid-cols-2">
                  {activeStories.map((story) => (
                    <label
                      key={story.id}
                      className="flex cursor-pointer items-start gap-1.5 py-1 text-xs"
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={storyIds.includes(story.id)}
                        onChange={(e) =>
                          setStoryIds((prev) =>
                            e.target.checked
                              ? [...prev, story.id]
                              : prev.filter((x) => x !== story.id),
                          )
                        }
                      />
                      <span className="shrink-0 font-mono text-[11px] text-stone-400">
                        {story.id}
                      </span>
                      <span className="min-w-0 flex-1">
                        <OverflowHint
                          text={story.title}
                          className="block truncate text-stone-800"
                        />
                      </span>
                      <span className="shrink-0 text-[11px] text-stone-400">{story.priority}</span>
                    </label>
                  ))}
                </div>
              ) : (
                <p className="mt-1.5 text-[11px] text-stone-400">
                  {storyDocId ? '这份分析还没有拆出用户故事' : '先选择一份需求分析记录'}
                </p>
              )}
              {!reqAnalysisOn ? (
                <p className="mt-1.5 text-[11px] text-stone-400">
                  需求分析插件已关闭；用户故事来源暂不可用，可改用「需求文档」。
                </p>
              ) : null}
            </div>
          ) : !requirementsOn ? (
            <p className="mt-1 text-[11px] text-stone-400">
              请先在「我的插件」中启用「需求文档库」后再选择。
            </p>
          ) : null}
        </section>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="min-w-0">
            <div className="mb-1 text-xs font-medium text-stone-500">引用知识库（可多选）</div>
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
        </div>

        {/* 底部：本次配置摘要 */}
        <section className="rounded-xl border border-stone-200 bg-stone-50/60 px-4 py-3">
          <div className="text-xs font-semibold text-stone-600">本次配置</div>
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
            <div className="min-w-0">
              <dt className="text-[10px] text-stone-400">用例类型</dt>
              <dd className="truncate text-xs text-stone-700">{typeLabel}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-[10px] text-stone-400">用例模板</dt>
              <dd className="truncate text-xs text-stone-700">{template?.title || '—'}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-[10px] text-stone-400">输出格式</dt>
              <dd className="truncate text-xs text-stone-700">
                {FORMAT_OPTS.find((o) => o.value === outputFormat)?.label ?? outputFormat}
              </dd>
            </div>
            <div className="col-span-2 min-w-0">
              <dt className="text-[10px] text-stone-400">需求来源</dt>
              <dd className="truncate text-xs text-stone-700">
                {reqMode === 'stories'
                  ? activeStoryDoc
                    ? `用户故事 · ${activeStoryDoc.title}（${pickedStoryCount}/${activeStories.length} 条）`
                    : '用户故事 · 未选择'
                  : selectedReq
                    ? `需求文档 · ${selectedReq}`
                    : '需求文档 · 未选择'}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-[10px] text-stone-400">引用知识库</dt>
              <dd className="truncate text-xs text-stone-700">
                {knowledgePaths.length ? `${knowledgePaths.length} 个文档` : '未引用'}
              </dd>
            </div>
            <div className="col-span-2 min-w-0 sm:col-span-3">
              <dt className="text-[10px] text-stone-400">提示词</dt>
              <dd className="truncate text-xs text-stone-700">{promptPath || '未选择'}</dd>
            </div>
          </dl>

          <p className="mt-2.5 text-[10px] leading-4 text-stone-400">
            确认后在主输入框描述本次生成范围并发送；结果写入用例管理，后续修改仍走该工作台会话。
          </p>
        </section>
      </SlideOverDrawer>
      <CaseTypeDialog
        mode={typeEditor}
        currentLabel={activeTypeDef.label}
        templateFolder={activeTypeDef.templateFolder}
        error={typeError ?? ''}
        onClose={() => {
          setTypeEditor(null);
          setTypeError(null);
        }}
        onSubmit={saveCaseType}
        onDelete={deleteCaseType}
      />
    </>
  );
}

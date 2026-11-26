import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import SlideOverDrawer from './SlideOverDrawer';
import { hydrateAppConfig } from '../../lib/app-config';
import { streamChat, type ChatMessage } from '../../lib/llm';
import { loadSettings, onSettingsChanged, type LLMSettings } from '../../lib/settings';
import {
  applyTestReportDraft,
  createTestReportDraft,
  discardTestReportDraft,
  fetchTestReportContext,
  type TestReportContext,
  type TestReportDraft,
} from '../../lib/test-report-review';
import { TEST_REPORT_PROMPT_SEEDS, kindDef, type TestReportKind } from '../../lib/test-reports';

interface Props {
  open: boolean;
  kind: TestReportKind;
  initialReportPath?: string;
  onClose: () => void;
  onApplied?: (receipt: { reportPath: string; receipt: string }) => void;
}

function statText(value: number | null | undefined, suffix = '') {
  return value == null ? '—' : `${value}${suffix}`;
}

export default function TestReportReviewDrawer({
  open,
  kind,
  initialReportPath = '',
  onClose,
  onApplied,
}: Props) {
  const def = kindDef(kind);
  const [settings, setSettings] = useState<LLMSettings | null>(null);
  const [reportPath, setReportPath] = useState(initialReportPath);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [context, setContext] = useState<TestReportContext | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [body, setBody] = useState('');
  const [draft, setDraft] = useState<TestReportDraft | null>(null);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  const modelReady = Boolean(settings?.baseURL && settings.apiKey && settings.model);

  useEffect(() => {
    void hydrateAppConfig()
      .then(() => setSettings(loadSettings()))
      .catch(() => setSettings(loadSettings()));
    return onSettingsChanged(() => setSettings(loadSettings()));
  }, []);

  const load = useCallback(
    async (paths?: string[], targetPath?: string, preserveBody = false) => {
      setLoading(true);
      setError('');
      setNotice('');
      try {
        const next = await fetchTestReportContext({
          kind,
          reportPath: targetPath ?? (reportPath || undefined),
          casePaths: paths,
          from: from || undefined,
          to: to || undefined,
        });
        setContext(next);
        setReportPath(next.reportPath);
        setSelectedPaths(next.documents.map((item) => item.path));
        if (!preserveBody) setBody(next.reportText);
        setDraft(null);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        setLoading(false);
      }
    },
    [from, kind, reportPath, to],
  );

  useEffect(() => {
    if (!open) return;
    setReportPath(initialReportPath);
    setContext(null);
    setBody('');
    setDraft(null);
    setError('');
    setNotice('');
    void load(undefined, initialReportPath, false);
    // 只在打开时初始化；输入后由“更新来源”显式重读，避免打字过程反复请求。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialReportPath]);

  const caseSummary = useMemo(() => {
    if (!context) return '';
    const parsed = context.documents.filter((item) => !item.parseError).length;
    return `${parsed}/${context.documents.length} 个用例文件可解析`;
  }, [context]);

  const sourcesDirty = useMemo(() => {
    if (!context) return false;
    const current = [...selectedPaths].sort().join('\n');
    const loaded = context.documents
      .map((item) => item.path)
      .sort()
      .join('\n');
    return current !== loaded || from !== context.from || to !== context.to;
  }, [context, from, selectedPaths, to]);

  async function refreshSources() {
    await load(selectedPaths, reportPath, true);
  }

  function toggleSource(path: string) {
    if (draft) {
      void discardTestReportDraft(draft.draftId).catch(() => {});
      setDraft(null);
    }
    setSelectedPaths((prev) =>
      prev.includes(path) ? prev.filter((item) => item !== path) : [...prev, path],
    );
  }

  const buildModelInput = useCallback(() => {
    if (!context) return '';
    const stats = context.stats;
    const lines = [
      `# ${context.label}`,
      '',
      `目标文件：${context.reportPath}`,
      `统计区间：${context.from || '未限定'} ~ ${context.to || '未限定'}`,
      '',
      '## 真实执行汇总',
      `- 用例总数：${stats.total}`,
      `- 已执行：${stats.executed}`,
      `- 通过：${stats.passed}`,
      `- 不通过：${stats.failed}`,
      `- 阻塞：${stats.blocked}`,
      `- 跳过：${stats.skipped}`,
      `- 待验证：${stats.pending}`,
      `- 通过率：${stats.passRate == null ? '无法计算' : `${stats.passRate}%`}`,
      `- 缺陷数：${stats.defects}`,
      '',
      '## 用例来源',
    ];
    for (const source of context.documents) {
      lines.push(`### ${source.path}`);
      if (source.parseError) {
        lines.push(`- 解析失败：${source.parseError}`);
        continue;
      }
      for (const item of source.cases.slice(0, 300)) {
        lines.push(
          `- ${item.no || '（无编号）'} ${item.title || '（无标题）'} · ${item.status || '待验证'}${item.defectNo ? ` · ${item.defectNo}` : ''}`,
        );
      }
    }
    lines.push('', '## 测试统计');
    if (!context.testStats.length) lines.push('- 无匹配记录');
    for (const item of context.testStats) {
      lines.push(`- ${item.date} · ${item.dimension}：${item.count}`);
    }
    lines.push('', '## 用例执行统计');
    if (!context.caseExec.length) lines.push('- 无匹配记录');
    for (const item of context.caseExec) {
      lines.push(
        `- ${item.date} · ${item.project}：总数 ${item.total} · 待执行 ${item.pending} · 已执行 ${item.executed}`,
      );
    }
    lines.push('', '## 缺口与待确认');
    if (!context.gaps.length) lines.push('- 无');
    for (const gap of context.gaps) lines.push(`- ${gap}`);
    if (context.reportText.trim()) {
      lines.push('', '## 当前报告正文（保留有效章节，改掉与材料冲突的内容）', context.reportText);
    }
    return lines.join('\n');
  }, [context]);

  async function generateDraft() {
    if (!context || generating) return;
    if (!modelReady || !settings) {
      setError('请先在设置中配置模型；也可以手动编辑正文后预览保存。');
      return;
    }
    setGenerating(true);
    setError('');
    setNotice('');
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let output = '';
    try {
      const messages: ChatMessage[] = [
        {
          role: 'system',
          content: [
            TEST_REPORT_PROMPT_SEEDS[kind],
            '',
            '## 本次输出契约',
            '只输出完整 Markdown 正文，不要解释过程。',
            '保留报告类型应有的章节；无法从材料确认的数据写“待补充”，不得估算。',
            '统计数字必须与用户消息中的“真实执行汇总”一致。',
            '至少写清范围、环境、执行统计、失败与缺陷、覆盖缺口、遗留风险和结论边界。',
          ].join('\n'),
        },
        { role: 'user', content: buildModelInput() },
      ];
      for await (const chunk of streamChat(settings, messages, ctrl.signal, { thinking: false })) {
        if (chunk.type !== 'content') continue;
        output += chunk.delta;
        setBody(output);
      }
      if (!output.trim()) throw new Error('模型没有返回报告正文');
      setNotice('模型草稿已生成，尚未保存；请核对统计、缺口和结论后预览保存。');
    } catch (reason) {
      if (!(reason instanceof DOMException && reason.name === 'AbortError')) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      abortRef.current = null;
      setGenerating(false);
    }
  }

  async function saveDraft() {
    if (!context || !body.trim() || saving) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const next = await createTestReportDraft({
        kind,
        reportPath,
        casePaths: selectedPaths,
        from: from || undefined,
        to: to || undefined,
        body,
        declaredStats: context.stats,
        expectedSourceRevision: context.sourceRevision,
      });
      setDraft(next);
      setNotice(next.message);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }

  async function applyDraft() {
    if (!draft || applying) return;
    setApplying(true);
    setError('');
    try {
      const receipt = await applyTestReportDraft(draft.draftId, draft.revision);
      setNotice(receipt.receipt);
      setDraft(null);
      await load(selectedPaths);
      onApplied?.({ reportPath: receipt.reportPath, receipt: receipt.receipt });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setApplying(false);
    }
  }

  async function discardDraft() {
    if (!draft) return;
    try {
      await discardTestReportDraft(draft.draftId);
      setDraft(null);
      setNotice('已取消报告草稿，目标报告没有变化。');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  function close() {
    abortRef.current?.abort();
    if (draft) void discardTestReportDraft(draft.draftId).catch(() => {});
    onClose();
  }

  const stats = context?.stats;

  return (
    <SlideOverDrawer
      open={open}
      onClose={close}
      title={`整理${def.label}`}
      widthClass="max-w-3xl"
      bodyClassName="space-y-4"
      footer={
        <footer className="shrink-0 border-t border-stone-100 px-4 py-3 flex flex-wrap items-center justify-end gap-2">
          <p className="mr-auto text-[11px] text-stone-400">
            {draft ? '草稿待确认，目标报告尚未变化' : '确认后会原子写入目标报告'}
          </p>
          <button
            type="button"
            onClick={close}
            className="h-8 rounded-lg border border-stone-200 px-3 text-xs text-stone-600 hover:bg-stone-50"
          >
            关闭
          </button>
          {draft ? (
            <>
              <button
                type="button"
                disabled={applying}
                onClick={() => void discardDraft()}
                className="h-8 rounded-lg border border-stone-200 px-3 text-xs text-stone-600 hover:bg-stone-50 disabled:opacity-40"
              >
                取消草稿
              </button>
              <button
                type="button"
                disabled={applying}
                onClick={() => void applyDraft()}
                className="h-8 rounded-lg bg-emerald-600 px-3 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-40"
              >
                {applying ? '写入中…' : '确认写入报告'}
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={!context || !body.trim() || saving || generating || sourcesDirty}
              onClick={() => void saveDraft()}
              className="h-8 rounded-lg bg-[#4176e6] px-3 text-xs font-medium text-white hover:bg-[#3565c7] disabled:opacity-40"
            >
              {saving ? '生成预览…' : sourcesDirty ? '先更新来源' : '预览保存'}
            </button>
          )}
        </footer>
      }
    >
      <p className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs leading-5 text-sky-900">
        先选择真实用例与区间，再整理报告。页面会显示来源、缺口和统计；任何草稿在确认前都不会改动报告文件。
      </p>

      {error ? (
        <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-700">
          <span className="min-w-0 flex-1 whitespace-pre-wrap">{error}</span>
          <button
            type="button"
            onClick={() => void refreshSources()}
            className="shrink-0 rounded-md border border-rose-200 bg-white px-2 py-1 text-[11px] hover:bg-rose-50"
          >
            重读材料
          </button>
        </div>
      ) : null}
      {notice ? (
        <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs leading-5 text-emerald-800">
          {notice}
        </p>
      ) : null}

      <section className="grid gap-3 sm:grid-cols-2">
        <label className="min-w-0 text-xs font-medium text-stone-600">
          目标报告
          <input
            value={reportPath}
            onChange={(event) => {
              setReportPath(event.target.value);
              if (draft) {
                void discardTestReportDraft(draft.draftId).catch(() => {});
                setDraft(null);
              }
            }}
            className="mt-1 h-9 w-full rounded-lg border border-stone-200 bg-white px-3 text-sm font-normal text-stone-800 outline-none focus:border-[#4176e6]"
            placeholder={`${def.folder}/报告.md`}
          />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="min-w-0 text-xs font-medium text-stone-600">
            开始日期
            <input
              type="date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
              className="mt-1 h-9 w-full rounded-lg border border-stone-200 bg-white px-2 text-xs font-normal outline-none focus:border-[#4176e6]"
            />
          </label>
          <label className="min-w-0 text-xs font-medium text-stone-600">
            结束日期
            <input
              type="date"
              value={to}
              onChange={(event) => setTo(event.target.value)}
              className="mt-1 h-9 w-full rounded-lg border border-stone-200 bg-white px-2 text-xs font-normal outline-none focus:border-[#4176e6]"
            />
          </label>
        </div>
      </section>

      <section className="rounded-xl border border-stone-200 bg-white p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1">
            <h3 className="text-xs font-semibold text-stone-800">用例来源</h3>
            <p className="mt-0.5 text-[11px] text-stone-400">
              {loading ? '读取中…' : caseSummary || '尚未读取材料'}
            </p>
          </div>
          <button
            type="button"
            disabled={loading || generating || saving || applying}
            onClick={() => void refreshSources()}
            className="h-7 rounded-md border border-stone-200 px-2.5 text-[11px] text-stone-600 hover:bg-stone-50 disabled:opacity-40"
          >
            {loading ? '重读中…' : sourcesDirty ? '应用来源变化' : '更新来源与统计'}
          </button>
        </div>
        {context?.documents.length ? (
          <ul className="mt-2 divide-y divide-stone-100 rounded-lg border border-stone-100">
            {context.documents.map((source) => {
              const checked = selectedPaths.includes(source.path);
              return (
                <li key={source.path}>
                  <label className="flex cursor-pointer items-start gap-2 px-2.5 py-2 hover:bg-stone-50">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleSource(source.path)}
                      className="mt-0.5 h-4 w-4 shrink-0 accent-[#4176e6]"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block break-all text-xs text-stone-700">{source.path}</span>
                      <span className="mt-0.5 block text-[11px] text-stone-400">
                        {source.parseError
                          ? source.parseError
                          : `${source.caseCount} 条用例 · ${source.fileHash.slice(0, 10)}`}
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-2 rounded-lg border border-dashed border-stone-200 px-3 py-6 text-center text-xs text-stone-400">
            当前类型目录下没有可读取的用例文件；可在「用例管理」补齐后回来重读。
          </p>
        )}
      </section>

      {stats ? (
        <section className="rounded-xl border border-stone-200 bg-stone-50/60 p-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            <span className="font-semibold text-stone-700">真实执行汇总</span>
            <span>总数 {statText(stats.total)}</span>
            <span>已执行 {statText(stats.executed)}</span>
            <span>通过 {statText(stats.passed)}</span>
            <span>不通过 {statText(stats.failed)}</span>
            <span>阻塞 {statText(stats.blocked)}</span>
            <span>待验证 {statText(stats.pending)}</span>
            <span>缺陷 {statText(stats.defects)}</span>
            <span>通过率 {statText(stats.passRate, '%')}</span>
          </div>
          {context.gaps.length ? (
            <ul className="mt-2 space-y-1 text-[11px] leading-5 text-amber-800">
              {context.gaps.map((gap) => (
                <li key={gap}>• {gap}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-[11px] text-emerald-700">未发现来源缺口。</p>
          )}
          {sourcesDirty ? (
            <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800">
              来源选择或日期已变化。先点「应用来源变化」重算统计，再生成或保存草稿。
            </p>
          ) : null}
        </section>
      ) : null}

      <section>
        <div className="mb-1.5 flex flex-wrap items-center gap-2">
          <label htmlFor="test-report-review-body" className="text-xs font-semibold text-stone-700">
            报告正文
          </label>
          <span className="text-[11px] text-stone-400">
            {body.length.toLocaleString('zh-CN')} 字
          </span>
          <div className="ml-auto flex items-center gap-2">
            {generating ? (
              <button
                type="button"
                onClick={() => abortRef.current?.abort()}
                className="h-7 rounded-md border border-rose-200 px-2.5 text-[11px] text-rose-600 hover:bg-rose-50"
              >
                停止生成
              </button>
            ) : null}
            <button
              type="button"
              disabled={!context || generating || applying}
              onClick={() => void generateDraft()}
              className="h-7 rounded-md border border-[#4176e6]/30 bg-[#eef4ff] px-2.5 text-[11px] font-medium text-[#315eb8] hover:bg-[#e3edff] disabled:opacity-40"
            >
              {generating ? '生成中…' : modelReady ? '用模型整理' : '手动编辑'}
            </button>
          </div>
        </div>
        <textarea
          id="test-report-review-body"
          value={body}
          onChange={(event) => {
            setBody(event.target.value);
            if (draft) {
              void discardTestReportDraft(draft.draftId).catch(() => {});
              setDraft(null);
            }
          }}
          rows={18}
          className="w-full resize-y rounded-xl border border-stone-200 bg-white px-3 py-2.5 font-mono text-xs leading-6 text-stone-800 outline-none focus:border-[#4176e6]"
          placeholder="# 测试报告\n\n先更新来源，再生成或手动整理正文。缺数据写“待补充”，不要编造执行结果。"
        />
      </section>

      {draft ? (
        <section className="rounded-xl border border-emerald-200 bg-emerald-50/40 p-3">
          <h3 className="text-xs font-semibold text-emerald-950">保存预览</h3>
          <p className="mt-1 text-[11px] leading-5 text-emerald-800">
            将写入 <span className="font-mono break-all">{draft.reportPath}</span>
            ；来源 revision 与统计已固定，确认时若材料变化会拒绝覆盖。
          </p>
          {draft.warnings.length ? (
            <ul className="mt-2 space-y-1 text-[11px] leading-5 text-amber-800">
              {draft.warnings.map((warning) => (
                <li key={warning}>• {warning}</li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
    </SlideOverDrawer>
  );
}

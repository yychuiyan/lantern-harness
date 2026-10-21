import { useEffect, useMemo, useState } from 'react';
import {
  deleteCaseSuite,
  hydrateCaseSuites,
  loadCaseSuites,
  onCaseSuitesChanged,
  type CaseSuite,
} from '../../lib/case-suites';
import type { TestCaseRow } from '../../lib/export';
import CaseTable from './CaseTable';
import ConfirmDialog from './ConfirmDialog';
import { showToast } from './Toast';

export interface KnowledgeSuiteProp {
  id: string;
  title: string;
  description?: string;
  cases: TestCaseRow[];
}

type OpenMap = Record<string, boolean>;

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      className={`w-3.5 h-3.5 text-stone-400 transition-transform ${open ? 'rotate-90' : ''}`}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
    >
      <path d="M7 5l6 5-6 5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SuiteRow({
  title,
  meta,
  count,
  open,
  onToggle,
  onDelete,
  cases,
}: {
  title: string;
  meta?: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  onDelete?: () => void;
  cases: TestCaseRow[];
}) {
  return (
    <div className="border border-stone-200 rounded-lg bg-white overflow-hidden">
      <div className="flex items-center gap-1 pr-2">
        <button
          type="button"
          onClick={onToggle}
          className="flex-1 min-w-0 flex items-center gap-2 px-3 py-2.5 text-left hover:bg-stone-50"
        >
          <Chevron open={open} />
          <span className="text-sm font-medium text-stone-800 truncate">{title}</span>
          <span className="text-[11px] text-stone-400 shrink-0">{count} 条</span>
          {meta ? (
            <span className="text-[11px] text-stone-400 shrink-0 truncate">{meta}</span>
          ) : null}
        </button>
        {onDelete ? (
          <button
            type="button"
            onClick={onDelete}
            className="h-7 px-2 text-xs text-red-600 rounded-md hover:bg-red-50 shrink-0"
          >
            删除
          </button>
        ) : null}
      </div>
      <div className={`tw-collapse ${open ? 'is-open' : ''}`}>
        <div className="tw-collapse-inner">
          <div className="px-3 pb-3 border-t border-stone-100 pt-3">
            <CaseTable cases={cases} />
          </div>
        </div>
      </div>
    </div>
  );
}

export default function CaseLibrary({
  knowledgeSuites,
  focusSuiteId,
}: {
  knowledgeSuites: KnowledgeSuiteProp[];
  focusSuiteId?: string | null;
}) {
  const [localSuites, setLocalSuites] = useState<CaseSuite[]>([]);
  const [groupOpen, setGroupOpen] = useState({ knowledge: true, local: true });
  const [openMap, setOpenMap] = useState<OpenMap>({});
  const [deleteSuiteId, setDeleteSuiteId] = useState<string | null>(null);

  useEffect(() => {
    void hydrateCaseSuites().then((s) => setLocalSuites(s.suites));
    return onCaseSuitesChanged(() => setLocalSuites(loadCaseSuites().suites));
  }, []);

  useEffect(() => {
    if (!focusSuiteId) return;
    setGroupOpen((g) => ({ ...g, local: true }));
    setOpenMap((m) => ({ ...m, [focusSuiteId]: true }));
    const el = document.getElementById(`case-suite-${focusSuiteId}`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [focusSuiteId]);

  const knowledgeWithCases = useMemo(
    () => knowledgeSuites.filter((s) => s.cases.length > 0),
    [knowledgeSuites],
  );

  function toggle(id: string) {
    setOpenMap((m) => ({ ...m, [id]: !m[id] }));
  }

  function expandAll(open: boolean) {
    const next: OpenMap = {};
    for (const s of knowledgeWithCases) next[`k:${s.id}`] = open;
    for (const s of localSuites) next[s.id] = open;
    setOpenMap(next);
    setGroupOpen({ knowledge: true, local: true });
  }

  function fmtTime(ts: number) {
    try {
      return new Date(ts).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return '';
    }
  }

  return (
    <section className="bg-[#f4f5f7] border border-stone-200 rounded-xl p-5 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-stone-900">用例库</h2>
          <p className="mt-0.5 text-xs text-stone-500">
            知识库测试用例与本机生成历史；点击套件展开查看。
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => expandAll(true)}
            className="h-7 px-2.5 text-xs text-stone-600 rounded-md border border-stone-200 bg-white hover:bg-stone-50"
          >
            全部展开
          </button>
          <button
            type="button"
            onClick={() => expandAll(false)}
            className="h-7 px-2.5 text-xs text-stone-600 rounded-md border border-stone-200 bg-white hover:bg-stone-50"
          >
            全部收起
          </button>
        </div>
      </div>

      <div className="space-y-2">
        <div className="rounded-lg border border-stone-200/80 bg-white/70 overflow-hidden">
          <button
            type="button"
            onClick={() => setGroupOpen((g) => ({ ...g, knowledge: !g.knowledge }))}
            className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-white"
          >
            <Chevron open={groupOpen.knowledge} />
            <span className="text-sm font-medium text-stone-700">知识库 · 测试用例</span>
            <span className="text-[11px] text-stone-400">{knowledgeWithCases.length} 套</span>
          </button>
          <div className={`tw-collapse ${groupOpen.knowledge ? 'is-open' : ''}`}>
            <div className="tw-collapse-inner">
              <div className="px-3 pb-3 space-y-2">
                {knowledgeWithCases.length === 0 ? (
                  <p className="text-xs text-stone-400 px-1 py-2">
                    暂无带用例表的知识库文档。可在 知识库管理/ 添加含 Markdown 表格的文档。
                  </p>
                ) : (
                  knowledgeWithCases.map((s) => (
                    <SuiteRow
                      key={s.id}
                      title={s.title}
                      meta={s.description}
                      count={s.cases.length}
                      open={Boolean(openMap[`k:${s.id}`])}
                      onToggle={() => toggle(`k:${s.id}`)}
                      cases={s.cases}
                    />
                  ))
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-stone-200/80 bg-white/70 overflow-hidden">
          <button
            type="button"
            onClick={() => setGroupOpen((g) => ({ ...g, local: !g.local }))}
            className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-white"
          >
            <Chevron open={groupOpen.local} />
            <span className="text-sm font-medium text-stone-700">本机生成历史</span>
            <span className="text-[11px] text-stone-400">{localSuites.length} 套</span>
          </button>
          <div className={`tw-collapse ${groupOpen.local ? 'is-open' : ''}`}>
            <div className="tw-collapse-inner">
              <div className="px-3 pb-3 space-y-2">
                {localSuites.length === 0 ? (
                  <p className="text-xs text-stone-400 px-1 py-2">
                    暂无保存的生成结果。在下方生成用例后点击「保存到用例库」。
                  </p>
                ) : (
                  localSuites.map((s) => (
                    <div key={s.id} id={`case-suite-${s.id}`}>
                      <SuiteRow
                        title={s.title}
                        meta={fmtTime(s.createdAt)}
                        count={s.cases.length}
                        open={Boolean(openMap[s.id])}
                        onToggle={() => toggle(s.id)}
                        onDelete={() => setDeleteSuiteId(s.id)}
                        cases={s.cases}
                      />
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={deleteSuiteId != null}
        title="删除本机套件"
        message={
          deleteSuiteId
            ? `确定删除「${localSuites.find((x) => x.id === deleteSuiteId)?.title ?? '该套件'}」？此操作不可恢复。`
            : ''
        }
        confirmLabel="删除"
        cancelLabel="取消"
        danger
        onClose={() => setDeleteSuiteId(null)}
        onConfirm={() => {
          if (!deleteSuiteId) return;
          const id = deleteSuiteId;
          const title = localSuites.find((x) => x.id === id)?.title ?? '该套件';
          setDeleteSuiteId(null);
          setLocalSuites(deleteCaseSuite(id).suites);
          showToast(`已删除「${title}」`, 'success');
        }}
      />
    </section>
  );
}

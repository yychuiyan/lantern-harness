import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  applyCaseReorder,
  listReorderSources,
  planCaseReorder,
  reorderSourceFromDoc,
  type CaseReorderPlan,
  type CaseReorderSource,
} from '../../lib/case-reorder';
import type { ReqAnalysisDoc } from '../../lib/req-analysis';
import SelectDropdown from './SelectDropdown';

interface Props {
  open: boolean;
  /** 要重排的用例文件相对路径（用例管理根下） */
  casePath: string;
  fileName: string;
  onClose: () => void;
  /** 重排完成：给出提示文案 */
  onDone: (message: string) => void;
  onError: (message: string) => void;
}

/** 「仅按引用编号」：不挂需求分析记录，只按「引用需求点」里的 RO / TP 编号排 */
const NONE = '__none__';

export default function CaseReorderDialog({
  open,
  casePath,
  fileName,
  onClose,
  onDone,
  onError,
}: Props) {
  const [docs, setDocs] = useState<ReqAnalysisDoc[]>([]);
  const [docId, setDocId] = useState<string>(NONE);
  const [plan, setPlan] = useState<CaseReorderPlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setDocId(NONE);
    setPlan(null);
    setError('');
    setBusy(false);
    void (async () => {
      try {
        const list = await listReorderSources();
        if (!alive) return;
        setDocs(list);
      } catch {
        if (alive) setDocs([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [open]);

  /** 按所选记录生成排序依据；读不到来源文档时只用条目 / 测试点序 */
  const resolveSource = useCallback(async (): Promise<CaseReorderSource> => {
    if (docId === NONE) return {};
    const doc = docs.find((d) => d.id === docId);
    if (!doc) return {};
    try {
      return await reorderSourceFromDoc(doc);
    } catch {
      return {
        outlineOrder: undefined,
        testPointIds: doc.testPoints?.points?.map((p) => p.id),
      };
    }
  }, [docId, docs]);

  useEffect(() => {
    if (!open || !casePath) return;
    let alive = true;
    setLoading(true);
    setError('');
    void (async () => {
      try {
        const source = await resolveSource();
        const next = await planCaseReorder(casePath, source);
        if (alive) setPlan(next);
      } catch (e) {
        if (!alive) return;
        setPlan(null);
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [open, casePath, resolveSource]);

  const options = useMemo(
    () => [
      { value: NONE, label: '仅按引用编号（RO / TP）', muted: true },
      ...docs.map((d) => ({
        value: d.id,
        label: d.title || d.sourceTitle || d.id,
        secondary: d.sourcePath,
      })),
    ],
    [docs],
  );

  async function confirm() {
    if (!plan || busy) return;
    if (plan.moved === 0) {
      onDone('用例顺序已是最终顺序，文件未改动');
      onClose();
      return;
    }
    setBusy(true);
    setError('');
    try {
      await applyCaseReorder(plan);
      onDone(`已重排 ${plan.total} 条用例（移动 ${plan.moved} 行），原文件已备份到「备份列表」`);
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      onError(`重排失败：${msg}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={() => (busy ? undefined : onClose())} className="relative z-110">
      <DialogBackdrop
        transition
        className="tw-dialog-backdrop-anim fixed inset-0 bg-black/30"
        aria-hidden="true"
      />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel
          transition
          className="tw-confirm-dialog tw-dialog-panel-anim flex w-full max-w-lg flex-col rounded-xl border border-stone-200 bg-white p-5 shadow-xl"
        >
          <DialogTitle className="tw-confirm-title text-base font-semibold text-stone-900">
            按需求重排用例
          </DialogTitle>
          <p className="mt-1 text-xs text-stone-500 break-all">{fileName}</p>

          <div className="mt-4">
            <div className="text-xs font-medium text-stone-500">需求来源</div>
            <SelectDropdown
              options={options}
              value={docId}
              onChange={setDocId}
              ariaLabel="重排依据的需求分析记录"
              className="mt-1.5"
              disabled={busy}
            />
            <p className="mt-1.5 text-[11px] leading-relaxed text-stone-400">
              排序口径：需求条目（RO）→ 条目内测试点（TP）→ 原文件顺序；用例编号会按新顺序重编为
              1…N。
            </p>
          </div>

          <div className="mt-4 rounded-lg border border-stone-200 bg-stone-50/60 p-3">
            {loading ? (
              <p className="text-xs text-stone-500">正在计算排序结果…</p>
            ) : plan ? (
              <>
                <p className="text-xs text-stone-600">
                  共 {plan.total} 条用例，需要移动{' '}
                  <span className="font-semibold tabular-nums">{plan.moved}</span> 行
                  {plan.moved === 0 ? '（已是最终顺序）' : ''}
                </p>
                {plan.preview.length ? (
                  <table className="mt-2 w-full table-fixed border-collapse text-[11px]">
                    <thead>
                      <tr className="text-stone-400">
                        <th className="w-10 pb-1 text-left font-normal">编号</th>
                        <th className="pb-1 text-left font-normal">用例标题</th>
                        <th className="w-40 pb-1 text-left font-normal">引用需求点</th>
                      </tr>
                    </thead>
                    <tbody>
                      {plan.preview.map((row, i) => (
                        <tr key={`${row.no}-${i}`} className="align-top text-stone-600">
                          <td className="py-0.5 pr-2 tabular-nums">{row.no}</td>
                          <td className="truncate py-0.5 pr-2">{row.title}</td>
                          <td className="truncate py-0.5 text-stone-500">{row.cite}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : null}
              </>
            ) : (
              <p className="text-xs text-stone-500">暂无可预览的行</p>
            )}
          </div>

          {error ? <p className="mt-2 text-[11px] leading-relaxed text-red-600">{error}</p> : null}

          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={onClose}
              className="tw-confirm-cancel h-8 px-3 text-sm rounded-lg text-stone-600 hover:bg-stone-100 disabled:opacity-40 transition-colors"
            >
              取消
            </button>
            <button
              type="button"
              disabled={busy || loading || !plan}
              onClick={() => void confirm()}
              className="h-8 px-4 text-sm font-medium text-white bg-[#4176e6] rounded-lg hover:bg-[#3565c7] disabled:opacity-40 transition-colors"
            >
              {busy ? '重排中…' : '开始重排'}
            </button>
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );
}

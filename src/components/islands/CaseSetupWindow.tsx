import { useEffect, useRef, useState } from 'react';
import { hydrateAppConfig } from '../../lib/app-config';
import type { CaseGenPluginConfig } from '../../lib/case-gen-config';
import CaseGenPanel from './CaseGenPanel';

type Setup = {
  recommended: {
    caseType: string;
    analysisId?: string;
    sourcePath?: string;
    storyIds: string[];
    testPointIds: string[];
    templateId?: string;
    outputFormat: 'xlsx' | 'csv' | 'md';
    requirementBreakdownId?: string;
    businessSystemIds: string[];
  };
  warnings: string[];
  businessSystems: Array<{ id: string; name: string }>;
};
type WindowResult = {
  setupId: string;
  status: 'pending' | 'confirmed' | 'cancelled';
  setup?: Setup;
  message: string;
};

async function request(path: string, body?: unknown): Promise<WindowResult> {
  const response = await fetch(
    `/__tb_case_design/setup-window${path}`,
    body === undefined
      ? { cache: 'no-store' }
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
  );
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '配置窗口请求失败');
  return result;
}

function initialConfig(setup: Setup): CaseGenPluginConfig {
  const r = setup.recommended;
  return {
    active: true,
    caseType: r.caseType,
    outputFormat: r.outputFormat,
    reqSource: r.analysisId
      ? { kind: 'stories', docId: r.analysisId, storyIds: r.storyIds }
      : { kind: 'doc', path: r.sourcePath || '' },
    testPointIds: r.testPointIds,
    templateId: r.templateId,
    requirementBreakdownContext: r.requirementBreakdownId
      ? { entryId: r.requirementBreakdownId, title: '', fileName: '', block: '' }
      : undefined,
    businessContexts: r.businessSystemIds.map((id) => ({
      systemId: id,
      systemName: setup.businessSystems.find((s) => s.id === id)?.name || '',
      functionCount: 0,
      flowCount: 0,
      block: '',
    })),
    templateHeaders: [],
    templateBody: '',
    promptBody: '',
    confirmedAt: 0,
  };
}

export default function CaseSetupWindow() {
  const [result, setResult] = useState<WindowResult | null>(null);
  const [initial, setInitial] = useState<CaseGenPluginConfig | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const completed = useRef(false);
  async function load() {
    setBusy(true);
    setError('');
    try {
      await hydrateAppConfig();
      const id = window.location.hash.slice(1);
      const next = id ? await request(`/${encodeURIComponent(id)}`) : await request('', {});
      window.history.replaceState(null, '', `#${next.setupId}`);
      completed.current = next.status !== 'pending';
      setResult(next);
      if (next.setup) {
        setInitial(initialConfig(next.setup));
        setOpen(true);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function cancel() {
    if (!result || completed.current) {
      setOpen(false);
      return;
    }
    setBusy(true);
    try {
      const next = await request(`/${result.setupId}/cancel`, {});
      completed.current = true;
      setResult(next);
      setOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mx-auto max-w-3xl px-5 py-10">
      <h1 className="tw-page-title">确认用例生成配置</h1>
      <p className="tw-page-desc mt-2">选择本次需求来源与覆盖范围，确认后返回聊天继续生成用例。</p>
      <div className="mt-6 space-y-4" aria-live="polite">
        {busy && <p role="status">正在读取配置…</p>}
        {error && (
          <p role="alert" className="text-red-600">
            {error}
          </p>
        )}
        {result?.status === 'confirmed' && (
          <p role="status">配置已确认。请返回聊天回复“配置已完成”，继续生成用例。</p>
        )}
        {result?.status === 'cancelled' && <p>配置已取消，未生成用例。</p>}
        {result?.setup?.warnings.map((warning) => (
          <p key={warning} className="text-sm text-amber-700">
            {warning}
          </p>
        ))}
        {error.includes('已过期') && (
          <button
            className="tw-btn"
            disabled={busy}
            onClick={() => {
              window.history.replaceState(null, '', window.location.pathname);
              setInitial(null);
              setOpen(false);
              void load();
            }}
          >
            重新创建配置窗口
          </button>
        )}
        {result && <p className="break-all text-xs text-stone-500">配置编号：{result.setupId}</p>}
        {result?.status === 'pending' && !open && (
          <button className="tw-btn" disabled={busy} onClick={() => setOpen(true)}>
            继续配置
          </button>
        )}
        {error && (
          <button className="tw-btn" disabled={busy} onClick={() => void load()}>
            重试
          </button>
        )}
      </div>
      {initial && result && (
        <CaseGenPanel
          open={open}
          initial={initial}
          externalConfirmation
          confirmationNote="确认后返回聊天继续生成；本窗口只保存本次选择。"
          onClose={() => {
            void cancel();
          }}
          onConfirm={async (cfg) => {
            const next = await request(`/${result.setupId}/confirm`, cfg);
            completed.current = true;
            setResult(next);
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}

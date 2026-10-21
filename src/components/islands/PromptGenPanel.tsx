/**
 * AI 工作台「生成提示词」插件面板：轻量配置，确认后由主会话发送时使用。
 */
import { useEffect, useState } from 'react';
import type { PromptGenPluginConfig } from '../../lib/prompt-gen-config';
import {
  addPromptKind,
  listPromptKinds,
  promptKindMeta,
  removePromptKind,
  updatePromptKind,
  type PromptGenKind,
  type PromptKindDef,
} from '../../lib/prompt-kinds';
import { fetchDocsHealth } from '../../lib/project-docs';
import NameEditDialog, { type NameEditMode } from './NameEditDialog';
import SelectDropdown from './SelectDropdown';
import SlideOverDrawer from './SlideOverDrawer';
import { showToast } from './Toast';

interface Props {
  open: boolean;
  onClose: () => void;
  initial?: PromptGenPluginConfig | null;
  onConfirm: (cfg: PromptGenPluginConfig) => void;
}

export default function PromptGenPanel({ open, onClose, initial, onConfirm }: Props) {
  const [docsLive, setDocsLive] = useState(false);
  const [titleHint, setTitleHint] = useState('');
  const [kinds, setKinds] = useState<PromptKindDef[]>(() => listPromptKinds());
  const [kind, setKind] = useState<PromptGenKind>(listPromptKinds()[0]?.id ?? 'case');
  const [error, setError] = useState<string | null>(null);
  /** 类型维护弹窗（新增 / 编辑 / 删除），与「生成用例」的用例类型维护同一套交互 */
  const [kindDialog, setKindDialog] = useState<NameEditMode | null>(null);
  /** 弹窗内的错误（重名 / 名称为空），弹窗不关就地提示 */
  const [kindError, setKindError] = useState<string | null>(null);

  const activeKind = kinds.find((k) => k.id === kind) ?? kinds[0] ?? promptKindMeta(kind);

  function refreshKinds(preferId?: string) {
    const list = listPromptKinds();
    setKinds(list);
    setKind((prev) => {
      const want = preferId ?? prev;
      if (list.some((x) => x.id === want)) return want;
      return list[0]?.id ?? prev;
    });
  }

  function saveKind(label: string) {
    const adding = kindDialog === 'add';
    try {
      if (adding) {
        const def = addPromptKind(label);
        refreshKinds(def.id);
        showToast(`已新增提示词类型「${def.label}」`, 'success');
      } else {
        updatePromptKind(kind, label);
        refreshKinds(kind);
        showToast(`已重命名为「${label.trim()}」`, 'success');
      }
      setKindDialog(null);
      setKindError(null);
    } catch (e) {
      // 弹窗不关，就地提示重名 / 名称非法
      const msg = e instanceof Error ? e.message : String(e);
      setKindError(msg);
      showToast(`${adding ? '新增' : '保存'}提示词类型失败：${msg}`, 'error');
    }
  }

  function deleteKind() {
    try {
      const label = activeKind.label;
      const next = removePromptKind(kind);
      setKinds(next);
      setKind(next[0]?.id ?? '');
      setKindDialog(null);
      setKindError(null);
      setError(null);
      showToast(`已删除提示词类型「${label}」`, 'success');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setKindError(msg);
      showToast(`删除提示词类型失败：${msg}`, 'error');
    }
  }

  useEffect(() => {
    if (!open) return;
    refreshKinds(initial?.kind);
    setTitleHint(initial?.titleHint ?? '');
    setKind(initial?.kind ?? listPromptKinds()[0]?.id ?? 'case');
    setKindDialog(null);
    setKindError(null);
    setError(null);
    void fetchDocsHealth('prompts').then(setDocsLive);
  }, [open, initial]);

  function confirm() {
    setError(null);
    if (!docsLive) {
      setError('本地文档服务未就绪，无法写入提示词库');
      return;
    }
    const cfg: PromptGenPluginConfig = {
      active: true,
      titleHint: titleHint.trim(),
      kind,
      confirmedAt: Date.now(),
      linkedPromptPath: initial?.linkedPromptPath,
    };
    onConfirm(cfg);
    onClose();
  }

  return (
    <SlideOverDrawer
      open={open}
      onClose={onClose}
      title="生成提示词 · 配置"
      closeAriaLabel="关闭生成提示词面板"
      escDisabled={kindDialog !== null}
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
            disabled={!docsLive}
            onClick={confirm}
            className="flex-1 h-9 text-sm font-medium text-white bg-[#4176e6] rounded-lg hover:bg-[#3565c7] disabled:opacity-40"
          >
            确认
          </button>
        </footer>
      }
    >
      {!docsLive ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          本地文档服务未就绪，无法读写提示词库。
        </div>
      ) : null}

      <p className="text-xs text-stone-500 leading-5">
        按所选类型生成可复用提示词：确认后在主输入框描述编写要求并发送，质检通过后写入提示词库，可在「提示词管理」中查看与引用。
      </p>

      {error ? (
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          {error}
        </div>
      ) : null}

      <div>
        <div className="mb-1 flex items-center gap-2">
          <div className="flex-1 text-xs font-medium text-stone-500">提示词类型</div>
          {/* 维护入口与「生成用例」的用例类型一致：一排小 chip，新增 / 编辑 / 删除走同一个弹窗 */}
          <button
            type="button"
            className="inline-flex h-[23px] items-center rounded border border-stone-200 px-1.5 text-[11px] leading-none text-[#4176e6] transition-colors hover:border-[#4176e6]/40 hover:bg-[#edf3fe]"
            onClick={() => {
              setKindDialog('add');
              setKindError(null);
            }}
          >
            新增
          </button>
          <button
            type="button"
            className="inline-flex h-[23px] items-center rounded border border-stone-200 px-1.5 text-[11px] leading-none text-stone-600 transition-colors hover:border-stone-300 hover:bg-stone-50"
            onClick={() => {
              setKindDialog('edit');
              setKindError(null);
            }}
          >
            编辑
          </button>
          <button
            type="button"
            className="inline-flex h-[23px] items-center rounded border border-stone-200 px-1.5 text-[11px] leading-none text-red-600 transition-colors hover:border-red-300 hover:bg-red-50 disabled:opacity-40 disabled:hover:border-stone-200 disabled:hover:bg-transparent"
            disabled={kinds.length <= 1}
            onClick={() => {
              setKindDialog('delete');
              setKindError(null);
            }}
          >
            删除
          </button>
        </div>
        <SelectDropdown
          options={kinds.map((o) => ({ value: o.id, label: o.label }))}
          value={kind}
          onChange={setKind}
          dimWhenOpen
        />
        <p className="mt-1 text-[11px] text-stone-400 leading-4">{activeKind.hint}</p>
        <p className="mt-1 text-[11px] text-stone-400 leading-4">
          类型决定生成时给模型的写作侧重（例如用例提示词要求约束 JSON 与模板字段），
          同时出现在这份提示词的配置标签里；不影响你在主输入框补充的具体要求。
        </p>
      </div>

      <div>
        <label className="text-xs font-medium text-stone-500" htmlFor="pg-title">
          期望名称
        </label>
        <input
          id="pg-title"
          value={titleHint}
          onChange={(e) => setTitleHint(e.target.value)}
          placeholder="如：接口测试用例提示词.md"
          className="mt-1 w-full h-9 px-3 text-sm rounded-lg border border-stone-200 focus:outline-none focus:ring-2 focus:ring-[#4176e6]/40"
        />
        <p className="mt-1.5 text-[11px] text-stone-400 leading-4">
          可填期望文件名；留空则由模型自拟。具体编写要求在主输入框描述。
        </p>
      </div>

      <NameEditDialog
        mode={kindDialog}
        entityLabel="提示词类型"
        currentLabel={activeKind.label}
        placeholder="如：缺陷分析提示词"
        error={kindError ?? ''}
        onClose={() => {
          setKindDialog(null);
          setKindError(null);
        }}
        onSubmit={saveKind}
        onDelete={deleteKind}
        hint={(name) => <>类型名称会写入这份提示词的配置标签：{name || '名称'}</>}
        deleteMessage={(label) => (
          <>确定删除「{label}」？已生成的提示词与文档不会被删除，只是不能再选这个类型。</>
        )}
      />
    </SlideOverDrawer>
  );
}

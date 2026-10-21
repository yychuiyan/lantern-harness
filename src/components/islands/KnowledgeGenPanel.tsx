/**
 * AI 工作台「生成知识库」插件面板：选分类后确认，对话输入素材生成入库。
 */
import { useEffect, useState } from 'react';
import type { KnowledgeGenPluginConfig } from '../../lib/knowledge-gen-config';
import {
  addKnowledgeCategory,
  listKnowledgeCategories,
  removeKnowledgeCategory,
  updateKnowledgeCategory,
  type KnowledgeCategory,
} from '../../lib/knowledge-categories';
import { fetchDocsHealth } from '../../lib/project-docs';
import NameEditDialog, { type NameEditMode } from './NameEditDialog';
import SelectDropdown from './SelectDropdown';
import SlideOverDrawer from './SlideOverDrawer';
import { showToast } from './Toast';

interface Props {
  open: boolean;
  onClose: () => void;
  initial?: KnowledgeGenPluginConfig | null;
  onConfirm: (cfg: KnowledgeGenPluginConfig) => void;
}

export default function KnowledgeGenPanel({ open, onClose, initial, onConfirm }: Props) {
  const [docsLive, setDocsLive] = useState(false);
  const [titleHint, setTitleHint] = useState('');
  const [categories, setCategories] = useState<KnowledgeCategory[]>(() =>
    listKnowledgeCategories(),
  );
  const [category, setCategory] = useState<KnowledgeCategory>(
    listKnowledgeCategories()[0] ?? '测试规范',
  );
  const [error, setError] = useState<string | null>(null);
  /** 分类维护弹窗（新增 / 编辑 / 删除），与「生成用例」的用例类型维护同一套交互 */
  const [catDialog, setCatDialog] = useState<NameEditMode | null>(null);
  /** 弹窗内的错误（重名 / 名称为空），弹窗不关就地提示 */
  const [catError, setCatError] = useState<string | null>(null);

  function refreshCats(prefer?: string) {
    const list = listKnowledgeCategories();
    setCategories(list);
    setCategory((prev) => {
      const want = prefer ?? prev;
      if (list.includes(want)) return want;
      return list[0] ?? prev;
    });
  }

  function saveCategory(label: string) {
    const adding = catDialog === 'add';
    try {
      if (adding) {
        const name = addKnowledgeCategory(label);
        refreshCats(name);
        showToast(`已新增分类「${name}」`, 'success');
      } else {
        const name = updateKnowledgeCategory(category, label);
        refreshCats(name);
        showToast(`已重命名为「${name}」`, 'success');
      }
      setCatDialog(null);
      setCatError(null);
    } catch (e) {
      // 弹窗不关，就地提示重名 / 名称非法
      const msg = e instanceof Error ? e.message : String(e);
      setCatError(msg);
      showToast(`${adding ? '新增' : '保存'}分类失败：${msg}`, 'error');
    }
  }

  function deleteCategory() {
    try {
      const label = category;
      const next = removeKnowledgeCategory(category);
      setCategories(next);
      setCategory(next[0] ?? '');
      setCatDialog(null);
      setCatError(null);
      setError(null);
      showToast(`已删除分类「${label}」`, 'success');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setCatError(msg);
      showToast(`删除分类失败：${msg}`, 'error');
    }
  }

  useEffect(() => {
    if (!open) return;
    refreshCats(initial?.category);
    setTitleHint(initial?.titleHint ?? '');
    setCategory(initial?.category ?? listKnowledgeCategories()[0] ?? '测试规范');
    setCatDialog(null);
    setCatError(null);
    setError(null);
    void fetchDocsHealth('knowledge').then(setDocsLive);
  }, [open, initial]);

  function confirm() {
    setError(null);
    if (!docsLive) {
      setError('本地文档服务未就绪，无法写入知识库');
      return;
    }
    const cfg: KnowledgeGenPluginConfig = {
      active: true,
      titleHint: titleHint.trim(),
      category,
      confirmedAt: Date.now(),
      linkedKnowledgePath: initial?.linkedKnowledgePath,
    };
    onConfirm(cfg);
    onClose();
  }

  return (
    <SlideOverDrawer
      open={open}
      onClose={onClose}
      title="生成知识库 · 配置"
      closeAriaLabel="关闭生成知识库面板"
      escDisabled={catDialog !== null}
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
          本地文档服务未就绪，无法读写知识库。
        </div>
      ) : null}

      <p className="text-xs text-stone-500 leading-5">
        按所选分类沉淀测试规范、方法论或环境约定：确认后在主输入框粘贴/描述素材并发送，质检通过后写入知识库，可在「知识库管理」中查看与
        @ 引用。
      </p>

      {error ? (
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          {error}
        </div>
      ) : null}

      <div>
        <div className="mb-1 flex items-center gap-2">
          <div className="flex-1 text-xs font-medium text-stone-500">分类</div>
          {/* 维护入口与「生成用例」的用例类型一致：一排小 chip，新增 / 编辑 / 删除走同一个弹窗 */}
          <button
            type="button"
            className="inline-flex h-[23px] items-center rounded border border-stone-200 px-1.5 text-[11px] leading-none text-[#4176e6] transition-colors hover:border-[#4176e6]/40 hover:bg-[#edf3fe]"
            onClick={() => {
              setCatDialog('add');
              setCatError(null);
            }}
          >
            新增
          </button>
          <button
            type="button"
            className="inline-flex h-[23px] items-center rounded border border-stone-200 px-1.5 text-[11px] leading-none text-stone-600 transition-colors hover:border-stone-300 hover:bg-stone-50"
            onClick={() => {
              setCatDialog('edit');
              setCatError(null);
            }}
          >
            编辑
          </button>
          <button
            type="button"
            className="inline-flex h-[23px] items-center rounded border border-stone-200 px-1.5 text-[11px] leading-none text-red-600 transition-colors hover:border-red-300 hover:bg-red-50 disabled:opacity-40 disabled:hover:border-stone-200 disabled:hover:bg-transparent"
            disabled={categories.length <= 1}
            onClick={() => {
              setCatDialog('delete');
              setCatError(null);
            }}
          >
            删除
          </button>
        </div>
        <SelectDropdown
          options={categories.map((c) => ({ value: c, label: c }))}
          value={category}
          onChange={setCategory}
          dimWhenOpen
        />
        <p className="mt-1 text-[11px] text-stone-400 leading-4">
          分类决定两件事：生成时告诉模型按哪类知识写（规范 / 方法论 / 环境约定侧重不同），
          入库时写进文档 frontmatter 的 category，知识库管理里就按它归类展示。
        </p>
      </div>

      <div>
        <label className="text-xs font-medium text-stone-500" htmlFor="kg-title">
          期望名称
        </label>
        <input
          id="kg-title"
          value={titleHint}
          onChange={(e) => setTitleHint(e.target.value)}
          placeholder="如：接口自动化环境约定.md"
          className="mt-1 w-full h-9 px-3 text-sm rounded-lg border border-stone-200 focus:outline-none focus:ring-2 focus:ring-[#4176e6]/40"
        />
        <p className="mt-1.5 text-[11px] text-stone-400 leading-4">
          可填期望文件名；留空则由模型自拟。素材与编写要求在主输入框描述。
        </p>
      </div>

      <NameEditDialog
        mode={catDialog}
        entityLabel="知识库分类"
        currentLabel={category}
        placeholder="如：安全基线"
        error={catError ?? ''}
        onClose={() => {
          setCatDialog(null);
          setCatError(null);
        }}
        onSubmit={saveCategory}
        onDelete={deleteCategory}
        hint={() => (
          <>分类写入文档 frontmatter，文件平铺存放于 知识库管理/；改名不会自动迁移已有文件。</>
        )}
        deleteMessage={(label) => (
          <>确定删除「{label}」？已入库的知识文档不会被删除，但该分类将不能再用于生成。</>
        )}
      />
    </SlideOverDrawer>
  );
}

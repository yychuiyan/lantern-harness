/**
 * 环境配置面板（Playwright）：按文本编辑项目里的 `.env` / `.env.<ENV>`。
 *
 * 口径：
 * - 文件是唯一真相：面板直接显示文件原文，注释、分组、空行原样保留，保存就是整份写回；
 *   分组标题与字段说明本来就写在模板注释里，不需要再翻译成一套表单。
 * - 模板 tab 是 `.env.example`：新建环境时复制它的内容，它也是「字段该怎么填」的唯一来源。
 * - 默认 tab 是 `example`（`.env.example` 模板），右边固定 `env`（`.env`）与 `prod`（`.env.prod`）。
 * - 打开一个还没创建的环境时，编辑器自动预填模板内容，保存即创建（骨架要求的就是「复制
 *   .env.example 为 .env.<ENV> 再填」）。
 * - `ENV` 由文件名决定（`.env.prod` 里恒为 `ENV=prod`），服务端写回时自动纠正。
 * - 面板直出原文，因此密钥也是明文；非 Playwright 项目只显示只读说明。
 *
 * 两种用法：独立弹窗（`UiAutoEnvDialog` 薄壳）或嵌进「项目配置」弹窗的分区（`embedded`）。
 * 面板自己管滚动与底部操作条，外层只负责给一个能收缩的高度。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  clearProjectAuth,
  deleteProjectEnv,
  envFileName,
  envLabel,
  fetchEnvTemplateFile,
  fetchProjectEnv,
  isSkeletonEnv,
  saveEnvTemplateFile,
  saveProjectEnvText,
  sanitizeEnvName,
  type EnvValidationItem,
  type ProjectEnvMeta,
} from '../../lib/ui-auto-env';
import type { UiAutoProject } from '../../lib/ui-auto';
import { updateProject } from '../../lib/ui-auto';
import { PmIcon } from './PmShared';
import { showToast } from './Toast';

const TEXT_SECONDARY = 'text-[var(--tw-label-secondary)]';
const TEXT_TERTIARY = 'text-[var(--tw-label-tertiary)]';
const INPUT =
  'h-8 w-full min-w-0 rounded-lg border border-(--tw-border) bg-(--tw-surface-panel) px-2.5 font-mono text-xs text-(--tw-label-primary) outline-none transition-colors placeholder:font-sans placeholder:text-(--tw-label-tertiary) focus:border-(--tw-accent) disabled:opacity-60';
const PRIMARY_BTN =
  'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-(--tw-accent) px-3 text-sm font-medium whitespace-nowrap text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50';
const GHOST_BTN =
  'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-(--tw-border) bg-(--tw-surface-panel) px-2.5 text-xs text-(--tw-label-secondary) transition-colors hover:bg-(--tw-session-hover-bg) hover:text-(--tw-label-primary) disabled:cursor-not-allowed disabled:opacity-50';
const EDITOR =
  'min-h-[360px] w-full resize-y rounded-xl border border-(--tw-border) bg-(--tw-surface-panel) px-3 py-2.5 font-mono text-[11px] leading-5 text-(--tw-label-primary) outline-none transition-colors placeholder:text-(--tw-label-tertiary) focus:border-(--tw-accent)';

interface Props {
  project: UiAutoProject;
  /** 保存后回调：带回来更新过的项目记录（改了默认环境时服务端会返回） */
  onSaved?: (project?: UiAutoProject) => void;
  /** 有没有未保存改动：外层用来拦关闭 */
  onDirtyChange?: (dirty: boolean) => void;
  /** 嵌在「项目配置」弹窗里：底部不再显示「关闭」 */
  embedded?: boolean;
}

/** 把模板灌进某个环境：ENV 按环境名改掉，没有 ENV 行就补一行；共用 `.env` 则去掉 ENV */
function seedFromTemplate(template: string, env: string): string {
  let body = String(template ?? '');
  // 共用 .env 不写 ENV：具体跑哪个环境由 .env.<ENV> 的文件名决定
  if (!env) return body.replace(/^\s*ENV\s*=.*(?:\n|$)/m, '');
  body = /^ENV\s*=/m.test(body)
    ? body.replace(/^ENV\s*=.*$/m, `ENV=${env}`)
    : `ENV=${env}\n${body}`;
  // prod 单独补一条熔断开关：默认 false，确认要跑生产再改 true
  if (env === 'prod' && !/^ALLOW_PROD\s*=/m.test(body)) {
    body = `${body.trimEnd()}\n\n# 生产保护：确认要跑生产时改成 true，false 时 env-loader 拒绝执行\nALLOW_PROD=false\n`;
  }
  return body;
}

/** 文本里出现的 key（给「其它环境已配置」做差集用） */
function keysInText(text: string): Set<string> {
  const keys = new Set<string>();
  for (const line of String(text ?? '').split('\n')) {
    const matched = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (matched) keys.add(matched[1]);
  }
  return keys;
}

export default function UiAutoEnvPanel({
  project,
  onSaved,
  onDirtyChange,
  embedded = false,
}: Props) {
  const supported = project.framework === 'playwright';
  const [meta, setMeta] = useState<ProjectEnvMeta | null>(null);
  const [env, setEnv] = useState(project.envName ?? '');
  /** 用户显式选过 / 新建的环境：即使文件还没创建，也要在 tab 里留一个位置 */
  const [pickedEnv, setPickedEnv] = useState('');
  /** 模板 tab（`.env.example`）：选中时编辑的是模板原文。默认就落在这里——它是新建环境的复制源 */
  const [showExample, setShowExample] = useState(true);
  /** 模板的真实文件名（老项目可能只有 `.env.test.example`）：保存提示用，界面 tab 统一显示 `example` */
  const exampleFile = meta?.example.file ?? '.env.example';
  const [text, setText] = useState('');
  const [baseline, setBaseline] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [warnings, setWarnings] = useState<EnvValidationItem[]>([]);
  /** 默认环境（`.env` / `.env.prod`）：改它不动文件内容，直接写项目记录 */
  const [settingDefault, setSettingDefault] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newEnv, setNewEnv] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [authFiles, setAuthFiles] = useState<string[]>([]);
  const [confirmAuth, setConfirmAuth] = useState(false);
  /** 只认最后一次请求，快速连点 tab 不会贴错数据 */
  const requestId = useRef(0);
  /** 当前 meta 的镜像：load 失败时要退回上一个环境，又不想让 load 依赖 meta（会自激） */
  const metaRef = useRef<ProjectEnvMeta | null>(null);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);

  const applyMeta = useCallback((next: ProjectEnvMeta, writeEditor = true) => {
    metaRef.current = next;
    setMeta(next);
    setEnv(next.env);
    setAuthFiles(next.authFiles);
    setWarnings([]);
    setError(next.error || '');
    // 打开面板默认落在模板 tab：这时别先把环境正文写进编辑器，否则会闪一下 `.env` 的内容
    if (!writeEditor) return;
    // 还没创建的环境：把模板内容预填进来，保存即创建
    const initial =
      !next.exists && next.example.text ? seedFromTemplate(next.example.text, next.env) : next.text;
    setText(initial);
    setBaseline(initial);
  }, []);

  /** 只换 meta（模板保存后刷新 schema），不动编辑器里的内容 */
  const applyMetaOnly = useCallback((next: ProjectEnvMeta) => {
    metaRef.current = next;
    setMeta(next);
    setAuthFiles(next.authFiles);
  }, []);

  const load = useCallback(
    async (target?: string, writeEditor = true) => {
      const ticket = requestId.current + 1;
      requestId.current = ticket;
      setLoading(true);
      setError('');
      try {
        const next = await fetchProjectEnv(project.id, target);
        if (requestId.current !== ticket) return;
        applyMeta(next, writeEditor);
      } catch (err) {
        if (requestId.current !== ticket) return;
        setError(err instanceof Error ? err.message : String(err));
        // 切失败时把 tab 退回上一个真正加载成功的环境
        setEnv(metaRef.current?.env ?? '');
      } finally {
        // 打开面板时还要接着读模板，这里先别解除 loading，避免编辑器空一帧
        if (requestId.current === ticket && writeEditor) setLoading(false);
      }
    },
    [applyMeta, project.id],
  );

  const loadExample = useCallback(async () => {
    const ticket = requestId.current + 1;
    requestId.current = ticket;
    setLoading(true);
    setError('');
    try {
      const file = await fetchEnvTemplateFile(
        project.id,
        metaRef.current?.example.file ?? '.env.example',
      );
      if (requestId.current !== ticket) return;
      setText(file.text);
      setBaseline(file.text);
      setWarnings([]);
    } catch (err) {
      if (requestId.current !== ticket) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (requestId.current === ticket) setLoading(false);
    }
  }, [project.id]);

  /**
   * 初始化只在「换项目」时跑：进来先读 meta（拿模板文件名与已有环境），再落到 `.env.example`。
   *
   * 不能把 `project.envName` 放进依赖：面板里改默认环境会回传新项目，依赖一变整块重跑，
   * 编辑器会被模板正文覆盖（标签页却还停在原环境），未保存的改动也会一起丢。
   * 初始环境名用 ref 记住，只在 project.id 变化时更新。
   */
  const envSeedRef = useRef(project.envName ?? '');
  useEffect(() => {
    envSeedRef.current = project.envName ?? '';
  }, [project.id, project.envName]);
  useEffect(() => {
    if (!supported) {
      setLoading(false);
      return;
    }
    void (async () => {
      await load(envSeedRef.current || undefined, false);
      await loadExample();
    })();
  }, [load, loadExample, supported]);

  /**
   * 环境 tab：`.env.example` 单独排第一，后面是 `.env`（共用默认）与 `.env.prod`。
   * test 不再占位，需要时用「新建环境」创建；其它环境文件存在才额外露出来。
   */
  const envOptions = useMemo(() => {
    const list = meta?.envs ?? [];
    const present = new Set(list.map((item) => item.env));
    const out = [...list];
    for (const name of ['', 'prod']) {
      if (present.has(name)) continue;
      present.add(name);
      out.push({ env: name, file: envFileName(name) });
    }
    // 服务端缺省会落在一个还没建文件的环境上：只给「用户自己点开 / 新建」的那个补 tab，
    // 别在列表里凭空多一个 `test 未创建`
    if (env && pickedEnv === env && !present.has(env)) out.push({ env, file: envFileName(env) });
    return out.sort((a, b) => (a.env === '' ? -1 : b.env === '' ? 1 : a.env.localeCompare(b.env)));
  }, [env, meta?.envs, pickedEnv]);

  const dirty = text !== baseline;
  const envCreated = Boolean(meta?.envs.some((item) => item.env === env));
  const envMissing = !showExample && !envCreated;
  /** `.env`（env 空串）是所有环境的兜底，记录里没写具体环境时默认就是它 */
  const defaultEnvName = meta?.defaultEnv ?? '';
  const isDefaultEnv = !showExample && defaultEnvName === env;

  /** 改默认环境：只写项目记录，不动文件内容（`''` 表示 `.env`） */
  const setDefaultEnv = async (next: string) => {
    setSettingDefault(true);
    setError('');
    try {
      const updated = await updateProject({ id: project.id, envName: next });
      const prev = metaRef.current;
      if (prev) applyMetaOnly({ ...prev, defaultEnv: updated.envName ?? next });
      onSaved?.(updated);
      showToast(next ? `默认环境已设为 .env.${next}` : '默认环境已设为 .env', 'success');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSettingDefault(false);
    }
  };
  const canSave = supported && !saving && (dirty || envMissing);

  const currentKeys = useMemo(() => keysInText(text), [text]);
  /** 其它环境配过、这份里还没有的 key：点一下补一行 `KEY=` */
  const crossMissing = useMemo(() => {
    const keyEnvs = meta?.crossEnv.keyEnvs ?? {};
    return Object.keys(keyEnvs)
      .filter((key) => !currentKeys.has(key))
      .slice(0, 12)
      .map((key) => ({ key, envs: keyEnvs[key] ?? [] }));
  }, [currentKeys, meta?.crossEnv.keyEnvs]);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const switchEnv = (next: string) => {
    if (!showExample && next === env) return;
    if (dirty) {
      setError('有未保存的改动：先保存或点「还原改动」再切换');
      return;
    }
    setCreating(false);
    setConfirmDelete(false);
    setShowExample(false);
    setPickedEnv(next);
    setEnv(next);
    void load(next);
  };

  const switchExample = () => {
    if (showExample) return;
    if (dirty) {
      setError('有未保存的改动：先保存或点「还原改动」再切换');
      return;
    }
    setCreating(false);
    setConfirmDelete(false);
    setShowExample(true);
    void loadExample();
  };

  const revert = () => {
    setError('');
    setWarnings([]);
    if (showExample) {
      void loadExample();
      return;
    }
    void load(env);
  };

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setError('');
    try {
      if (showExample) {
        await saveEnvTemplateFile({
          projectId: project.id,
          file: meta?.example.file ?? '.env.example',
          text,
        });
        setBaseline(text);
        // 模板改了 schema：只刷新 meta，别用环境文件覆盖编辑器
        const next = await fetchProjectEnv(project.id, env);
        applyMetaOnly(next);
        showToast(`已保存 ${exampleFile}`, 'success');
      } else {
        const result = await saveProjectEnvText({
          projectId: project.id,
          env,
          text,
        });
        setText(result.text);
        setBaseline(result.text);
        setWarnings(result.validation.warnings);
        setAuthFiles(result.authFiles);
        const prev = metaRef.current;
        if (prev) {
          const nextDefault = result.project?.envName ?? prev.defaultEnv;
          applyMetaOnly({
            ...prev,
            env: result.env,
            file: result.file,
            exists: true,
            text: result.text,
            envs: result.envs,
            defaultEnv: nextDefault,
          });
        }
        showToast(env ? `已保存 ${result.file}` : '已保存 .env', 'success');
        onSaved?.(result.project);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  /** 新建环境：直接按模板内容把 `.env.<ENV>` 建出来（骨架要求的「复制 .env.example」） */
  const createEnv = async () => {
    const name = sanitizeEnvName(newEnv);
    if (!name) {
      setError('环境名只能用字母、数字、下划线与短横线，且以小写字母开头');
      return;
    }
    setCreating(false);
    setNewEnv('');
    setError('');
    if (meta?.envs.some((item) => item.env === name)) {
      switchEnv(name);
      return;
    }
    setSaving(true);
    try {
      await saveProjectEnvText({
        projectId: project.id,
        env: name,
        text: seedFromTemplate(meta?.example.text ?? '', name),
      });
      showToast(`已按模板创建 ${envFileName(name)}`, 'success');
      setShowExample(false);
      setPickedEnv(name);
      setEnv(name);
      await load(name);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const removeEnv = async () => {
    if (!env) return;
    setDeleting(true);
    setError('');
    try {
      const result = await deleteProjectEnv({ projectId: project.id, env });
      setConfirmDelete(false);
      showToast(`已删除 ${result.removed}`, 'success');
      // 不指定 env：交给服务端按「默认 → 第一个已有 → dev」重选，别停在刚删掉的那个上
      setPickedEnv('');
      await load();
      onSaved?.(result.project);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  };

  const clearAuth = async () => {
    setConfirmAuth(false);
    try {
      const result = await clearProjectAuth(project.id);
      setAuthFiles(result.authFiles);
      showToast(
        result.removed.length
          ? `已清理 ${result.removed.length} 个登录态文件`
          : '没有需要清理的登录态',
        'success',
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  /** 补一行 `KEY=`（其它环境配过但这份里还没有的 key） */
  const appendKey = (key: string) => {
    const body = text.replace(/\s*$/, '');
    setText(`${body ? `${body}\n` : ''}${key}=\n`);
    editorRef.current?.focus();
  };

  const filePath = showExample
    ? `${project.dir.replace(/\/+$/, '')}/${meta?.example.file ?? '.env.example'}`
    : `${project.dir.replace(/\/+$/, '')}/${envFileName(env)}`;
  const isProd = !showExample && env === 'prod';
  /** 只允许删用户自己新建的环境：`.env`（共用底稿）与 `.env.prod` 是骨架约定 */
  const canDeleteEnv = !showExample && envCreated && !isSkeletonEnv(env);
  const pad = embedded ? 'px-6 py-5' : 'px-5 py-4';
  const saveLabel = showExample ? '保存' : envMissing ? '创建环境' : '保存';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={`min-h-0 flex-1 overflow-auto ${pad}`}>
        {!supported ? (
          <p className="rounded-xl bg-(--tw-surface-recessed) px-3.5 py-3 text-[11px] leading-5 text-[var(--tw-label-secondary)]">
            {'环境配置目前只支持 Playwright 项目：骨架用 ENV + .env.<ENV> 这套约定。'}
            pytest / Selenium 的配置方式各不相同，暂不在这里编辑，避免改出两套口径。
          </p>
        ) : !meta ? (
          <p className={`text-[11px] ${TEXT_TERTIARY}`}>正在读取环境文件…</p>
        ) : (
          <div
            className={`space-y-4 transition-opacity duration-150 ${loading ? 'pointer-events-none opacity-60' : ''}`}
            aria-busy={loading}
          >
            {/* 环境切换：`.env.example` 排第一，其次是 .env 与各环境 */}
            <section>
              <div className="flex flex-wrap items-center gap-2">
                <div className="inline-flex flex-wrap items-center gap-0.5 rounded-lg bg-(--tw-surface-recessed) p-1">
                  <button
                    type="button"
                    onClick={switchExample}
                    className={`inline-flex h-6 items-center gap-1 rounded-md px-2 text-[11px] transition-colors ${
                      showExample
                        ? 'bg-(--tw-surface-panel) font-medium text-(--tw-label-primary) shadow-sm'
                        : 'text-[var(--tw-label-secondary)] hover:text-(--tw-label-primary)'
                    }`}
                  >
                    example
                    {meta.example.exists ? null : (
                      <span className="text-[9px] font-normal text-(--tw-label-tertiary)">
                        未创建
                      </span>
                    )}
                  </button>
                  {envOptions.map((item) => {
                    const active = !showExample && item.env === env;
                    const created = meta.envs.some((file) => file.env === item.env);
                    return (
                      <button
                        key={item.env || 'base'}
                        type="button"
                        onClick={() => switchEnv(item.env)}
                        className={`inline-flex h-6 items-center gap-1 rounded-md px-2 text-[11px] transition-colors ${
                          active
                            ? 'bg-(--tw-surface-panel) font-medium text-(--tw-label-primary) shadow-sm'
                            : 'text-[var(--tw-label-secondary)] hover:text-(--tw-label-primary)'
                        }`}
                      >
                        {envLabel(item.env)}
                        {created ? null : (
                          <span className="text-[9px] font-normal text-(--tw-label-tertiary)">
                            未创建
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
                {creating ? (
                  <span
                    className="inline-flex items-center gap-1.5"
                    onBlur={(event) => {
                      // 焦点移出这一组（且输入框还是空的）时自动收起，别留一个空框占位。
                      // 点「创建」按钮时焦点仍在这组里，不会被提前收掉。
                      const next = event.relatedTarget as Node | null;
                      if (next && event.currentTarget.contains(next)) return;
                      if (!newEnv.trim()) setCreating(false);
                    }}
                  >
                    <input
                      className={`${INPUT} h-7 w-24`}
                      value={newEnv}
                      onChange={(event) => setNewEnv(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void createEnv();
                        if (event.key === 'Escape') setCreating(false);
                      }}
                      placeholder="prod2"
                      aria-label="新环境名"
                      spellCheck={false}
                      autoFocus
                    />
                    <button
                      type="button"
                      className={GHOST_BTN}
                      onClick={() => void createEnv()}
                      disabled={saving}
                    >
                      创建
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      if (dirty) {
                        setError('有未保存的改动：先保存或点「还原改动」再新建环境');
                        return;
                      }
                      setShowExample(false);
                      setCreating(true);
                      setNewEnv('');
                      setError('');
                    }}
                    className={`inline-flex h-8 items-center gap-1 rounded-lg border border-dashed border-(--tw-border) px-2.5 text-[11px] ${TEXT_SECONDARY} transition-colors hover:border-(--tw-accent) hover:text-(--tw-accent)`}
                  >
                    <PmIcon name="plus" size={11} />
                    新建环境
                  </button>
                )}
                {canDeleteEnv ? (
                  confirmDelete ? (
                    <span className="inline-flex items-center gap-1.5">
                      <span className="text-[11px] text-amber-700">
                        删除 {envFileName(env)}？变量会一起删掉
                      </span>
                      <button
                        type="button"
                        className={GHOST_BTN}
                        onClick={() => void removeEnv()}
                        disabled={deleting}
                      >
                        {deleting ? '删除中…' : '确认删除'}
                      </button>
                      <button
                        type="button"
                        className={GHOST_BTN}
                        onClick={() => setConfirmDelete(false)}
                        disabled={deleting}
                      >
                        取消
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(true)}
                      disabled={saving || deleting}
                      className={`inline-flex h-8 items-center gap-1 rounded-lg border border-(--tw-border) px-2.5 text-[11px] ${TEXT_SECONDARY} transition-colors hover:border-red-300 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-50`}
                    >
                      <PmIcon name="trash" size={11} />
                      删除环境
                    </button>
                  )
                ) : null}
              </div>
              <p
                className={`mt-2 flex min-w-0 items-center gap-1.5 font-mono text-[10px] ${TEXT_TERTIARY}`}
              >
                <PmIcon name="file" size={11} className="shrink-0" />
                <span className="min-w-0 truncate">{filePath || '（未选择环境）'}</span>
                {showExample ? (
                  <span className="shrink-0 font-sans">· 新建环境时复制的就是这份</span>
                ) : envMissing ? (
                  <span className="shrink-0 font-sans">· 还不存在，已按模板预填，保存即创建</span>
                ) : null}
              </p>
            </section>

            {/* 默认环境 + 登录态：模板 tab 下不显示（模板不属于某个环境） */}
            {showExample ? null : (
              <section className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-(--tw-surface-recessed) px-3.5 py-2.5">
                <label className={`inline-flex items-center gap-1.5 text-[11px] ${TEXT_SECONDARY}`}>
                  <input
                    type="checkbox"
                    className="accent-[var(--tw-accent)]"
                    checked={isDefaultEnv}
                    disabled={saving || settingDefault || (env === '' && isDefaultEnv)}
                    onChange={(event) => void setDefaultEnv(event.target.checked ? env : '')}
                  />
                  记为该项目默认环境
                </label>
                {env === '' && isDefaultEnv ? (
                  /* .env 是所有环境的兜底：没指定具体环境时跑的就是它，所以这一项不能取消 */
                  <span className={`text-[10px] ${TEXT_TERTIARY}`}>没选具体环境时就用它</span>
                ) : null}
                <span className={`text-[10px] ${TEXT_TERTIARY}`}>
                  当前默认：{meta.defaultEnv ? `.env.${meta.defaultEnv}` : '.env'}
                </span>
                <span className={`text-[11px] ${TEXT_TERTIARY}`}>·</span>
                {authFiles.length ? (
                  confirmAuth ? (
                    <span className="inline-flex items-center gap-1.5">
                      <span className="text-[11px] text-amber-700">
                        删除 {authFiles.join(' / ')}？
                      </span>
                      <button type="button" className={GHOST_BTN} onClick={() => void clearAuth()}>
                        确认清理
                      </button>
                      <button
                        type="button"
                        className={GHOST_BTN}
                        onClick={() => setConfirmAuth(false)}
                      >
                        取消
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className={GHOST_BTN}
                      onClick={() => setConfirmAuth(true)}
                      disabled={saving}
                    >
                      <PmIcon name="trash" size={12} />
                      清理登录态（{authFiles.length}）
                    </button>
                  )
                ) : (
                  <span className={`text-[11px] ${TEXT_TERTIARY}`}>没有登录态文件</span>
                )}
              </section>
            )}

            {isProd ? (
              <p className="rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-4 text-amber-700">
                prod 环境需要同时设置 ALLOW_PROD=true，否则项目里的 env-loader 会直接拒绝运行。
              </p>
            ) : null}

            {/* 编辑器：直接显示文件原文 */}
            <section>
              <div className="mb-1.5 flex items-baseline justify-between gap-2">
                <span className={`text-[11px] font-medium ${TEXT_SECONDARY}`}>
                  {showExample ? 'example' : envFileName(env)}
                </span>
                <span className={`text-[10px] ${TEXT_TERTIARY}`}>
                  {keysInText(text).size} 个变量
                </span>
              </div>
              <textarea
                ref={editorRef}
                className={EDITOR}
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder={
                  showExample
                    ? '# 基础\nBASE_URL=http://127.0.0.1:5173\n\n# 登录账号\n# 管理员账号\nADMIN_USERNAME=\nADMIN_PASSWORD='
                    : 'BASE_URL=\n'
                }
                spellCheck={false}
                aria-label={showExample ? '环境变量模板原文' : '环境文件原文'}
              />
              <p className={`mt-1.5 text-[10px] leading-4 ${TEXT_TERTIARY}`}>
                {showExample
                  ? '`# 标题` 上下留空行 = 分组；紧贴变量上一行的 `# 说明` = 字段说明。新建环境时会复制这份内容。'
                  : env
                    ? `ENV 由文件名决定：保存时自动写成 ENV=${env}。注释与空行都会原样保留。`
                    : '共用默认值：具体环境没配的变量会从这里补；注释与空行都会原样保留。'}
              </p>
            </section>

            {/* 其它环境已配过的 key：点一下补一行，省得手抄 */}
            {crossMissing.length ? (
              <section>
                <div className="mb-1.5 flex items-baseline gap-1.5">
                  <span className={`text-[11px] font-medium ${TEXT_SECONDARY}`}>
                    其它环境已配置
                  </span>
                  <span className={`text-[10px] ${TEXT_TERTIARY}`}>点一下补一行</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {crossMissing.map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      className={`inline-flex items-center gap-1 rounded-md border border-(--tw-border) bg-(--tw-surface-panel) px-1.5 py-0.5 font-mono text-[10px] ${TEXT_SECONDARY} transition-colors hover:border-(--tw-accent) hover:text-(--tw-accent)`}
                      onClick={() => appendKey(item.key)}
                    >
                      {item.key}
                      <span className={`font-sans text-[9px] ${TEXT_TERTIARY}`}>
                        {item.envs.map((name) => (name ? name : '.env')).join('/')}
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            ) : null}

            {warnings.length ? (
              <ul className="space-y-1">
                {warnings.map((item) => (
                  <li
                    key={`${item.key}-${item.message}`}
                    className="rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-4 text-amber-700"
                  >
                    {item.message}
                  </li>
                ))}
              </ul>
            ) : null}

            <p className={`text-[10px] leading-4 ${TEXT_TERTIARY}`}>
              `.env` / `.env.*` 已在骨架的 .gitignore
              里；面板直出文件原文，密码也是明文，共享屏幕时注意。
            </p>
          </div>
        )}

        {error ? (
          <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-[11px] leading-4 text-red-600">
            {error}
          </p>
        ) : null}
      </div>

      {/* 操作条：左边是当前状态（未保存 / 已保存），右边才是按钮 */}
      <div
        className={`flex shrink-0 items-center gap-2 border-t border-(--tw-border) py-2.5 ${
          embedded ? 'px-6' : 'px-5'
        }`}
      >
        <span className={`mr-auto inline-flex items-center gap-1.5 text-[11px] ${TEXT_TERTIARY}`}>
          {dirty ? (
            <>
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
              有未保存改动
            </>
          ) : showExample ? (
            <>
              {meta?.example.exists ? (
                <PmIcon name="check" size={11} className="text-emerald-500" />
              ) : null}
              {meta?.example.exists ? '已与磁盘一致' : 'example 模板还没创建'}
            </>
          ) : (
            <>
              {envCreated ? <PmIcon name="check" size={11} className="text-emerald-500" /> : null}
              {envCreated ? '已与磁盘一致' : '还没有这个环境文件'}
            </>
          )}
          {loading ? (
            <span
              className="ml-1 inline-block h-3 w-3 animate-spin rounded-full border border-(--tw-border) border-t-(--tw-accent)"
              aria-hidden="true"
            />
          ) : null}
        </span>
        {dirty ? (
          <button type="button" className={GHOST_BTN} onClick={revert} disabled={saving}>
            还原改动
          </button>
        ) : null}
        <button
          type="button"
          className={PRIMARY_BTN}
          onClick={() => void save()}
          disabled={!canSave}
        >
          {saving ? '保存中…' : saveLabel}
        </button>
      </div>
    </div>
  );
}

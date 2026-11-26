import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogBackdrop,
  DialogDescription,
  DialogPanel,
  DialogTitle,
} from '@headlessui/react';
import {
  isBrowserSkillMode,
  skillRequest,
  type SpaceSkill,
  type SkillDetail,
} from '../../lib/space-skills';
import { PLUGIN_CATALOG } from '../../lib/plugins';
import SelectDropdown from './SelectDropdown';
import LocalDeployGuideLink from './LocalDeployGuideLink';
import { showToast } from './Toast';

const button =
  'inline-flex h-9 items-center justify-center rounded-lg border border-(--tw-border) px-3 text-sm hover:bg-(--tw-surface-recessed) disabled:opacity-40';
const field =
  'w-full min-w-0 rounded-lg border border-(--tw-border) bg-(--tw-surface-panel) p-3 text-sm text-(--tw-label-primary) outline-none focus:border-(--tw-accent)';

function SkillGlyph() {
  return (
    <span
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-(--tw-accent-soft) text-(--tw-accent)"
      aria-hidden="true"
    >
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor">
        <path
          d="M12 3.25 15.7 6l3.05 5.15L17.3 17l-5.3 3.75L6.7 17l-1.45-5.85L8.3 6 12 3.25Z"
          strokeWidth="1.55"
          strokeLinejoin="round"
        />
        <path d="m12 7.4 2.5 1.8 1 3.15-1.7 2.8-1.8.1-2-2.15.6-3.1L12 7.4Z" strokeWidth="1.35" />
      </svg>
    </span>
  );
}

function pluginLabel(id: string) {
  return PLUGIN_CATALOG.find((plugin) => plugin.id === id)?.name || id;
}
export default function PluginsSkillsPanel({
  onCount,
  readOnly = false,
}: {
  onCount?: (count: number) => void;
  readOnly?: boolean;
}) {
  const [skills, setSkills] = useState<SpaceSkill[]>([]),
    [detail, setDetail] = useState<SkillDetail | null>(null);
  const [owner, setOwner] = useState(() => new URLSearchParams(location.search).get('owner') || '');
  const [query, setQuery] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true);
  const [section, setSection] = useState('rules'),
    [versions, setVersions] = useState<number[]>([]),
    [version, setVersion] = useState('');
  const [togglingGroup, setTogglingGroup] = useState('');
  const [input, setInput] = useState('{\n  "rows": [],\n  "columns": [],\n  "sourceIds": []\n}'),
    [result, setResult] = useState('');
  const [creating, setCreating] = useState(false),
    [name, setName] = useState(''),
    [body, setBody] = useState('');
  const [browserMode, setBrowserMode] = useState(false);
  async function refresh() {
    const data = await skillRequest<{ skills: SpaceSkill[] }>('list');
    setSkills(data.skills);
    setBrowserMode(isBrowserSkillMode());
    onCount?.(new Set(data.skills.map((x) => x.group)).size);
  }
  useEffect(() => {
    let live = true;
    void skillRequest('migrate')
      .then(() => skillRequest<{ skills: SpaceSkill[] }>('list'))
      .then((data) => {
        if (live) {
          setSkills(data.skills);
          setBrowserMode(isBrowserSkillMode());
          onCount?.(new Set(data.skills.map((x) => x.group)).size);
        }
        const params = new URLSearchParams(location.search);
        const legacy = params.get('file') || params.get('path');
        const chosen = data.skills.find(
          (x) => x.id === params.get('skill') || (!!legacy && x.legacyPath === legacy),
        );
        if (live && chosen) void open(chosen.id);
      })
      .catch((e) => {
        if (live) setError(String(e.message || e));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [onCount]);
  async function open(id: string) {
    setError('');
    setResult('');
    try {
      const [{ skill }, history] = await Promise.all([
        skillRequest<{ skill: SkillDetail }>('read', { id }),
        skillRequest<{ versions: number[] }>('history', { id }),
      ]);
      setDetail(skill);
      setVersions(history.versions);
      setVersion(history.versions[0]?.toString() || '');
      setSection('rules');
      setCreating(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  async function action(run: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await run();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function toggleSkillGroup(group: string, enabled: boolean) {
    setTogglingGroup(group);
    setError('');
    try {
      await skillRequest('set-enabled', { group, enabled });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setTogglingGroup('');
    }
  }
  const visible = skills.filter((x) => {
    const refs = x.pluginRefs?.length ? x.pluginRefs : x.owner ? [x.owner] : [];
    return (
      (!owner || refs.includes(owner)) &&
      `${x.name} ${x.variant} ${x.description} ${refs.map(pluginLabel).join(' ')}`
        .toLowerCase()
        .includes(query.toLowerCase())
    );
  });
  const groups = [...new Set(visible.map((x) => x.group))];
  const detailVariants = detail ? skills.filter((x) => x.group === detail.group) : [];
  const detailPluginRefs = detail?.pluginRefs?.length
    ? detail.pluginRefs
    : detail?.owner
      ? [detail.owner]
      : [];
  const detailIsSystem = detail?.system ?? Boolean(detailPluginRefs.length);
  const detailDescription =
    detailVariants.find((item) => !item.description.startsWith('旧版变体'))?.description ||
    detail?.description ||
    '';
  return (
    <section className="min-h-0 flex-1 overflow-auto p-5 text-(--tw-label-primary)">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-xs text-(--tw-label-tertiary)">
          {groups.length} 个技能 · {visible.length} 个内部变体
        </span>
        <label className="ml-auto min-w-0">
          <input
            className={field + ' h-9 py-1'}
            aria-label="搜索技能"
            placeholder="搜索技能或变体…"
            autoComplete="off"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <button
          className={button}
          disabled={readOnly}
          title={readOnly ? '在线只读预览，请本地部署后新建技能' : undefined}
          onClick={() => {
            setCreating(true);
            setDetail(null);
            setName('');
            setBody('');
          }}
        >
          新建技能
        </button>
        <label
          className={button + ' cursor-pointer' + (readOnly ? ' opacity-40' : '')}
          title={readOnly ? '在线只读预览，请本地部署后导入技能' : undefined}
        >
          导入技能
          <input
            className="hidden"
            type="file"
            accept=".md,.json"
            aria-label="导入技能文件"
            disabled={busy || readOnly}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              void action(async () => {
                if (file.size > 2 * 1024 * 1024) throw new Error('文件超过2MB');
                const text = await file.text();
                const bundle = file.name.endsWith('.json')
                  ? JSON.parse(text)
                  : {
                      schemaVersion: 1,
                      name: file.name.replace(/\.md$/i, ''),
                      files: { 'SKILL.md': text },
                    };
                const data = await skillRequest<{ skill: SkillDetail }>('import', { bundle });
                await refresh();
                await open(data.skill.id);
                showToast('技能已导入，脚本不会自动运行', 'success');
              });
              e.target.value = '';
            }}
          />
        </label>
      </div>
      <p className="mb-4 text-xs text-(--tw-label-secondary)">
        技能是独立能力包，包含业务规则、流程和资源。已关联业务的技能默认启用且保持常驻；未关联业务的自定义技能可独立启停。
        加载技能不会自动执行脚本。
      </p>
      {browserMode ? (
        <div
          className="mb-4 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs leading-5 text-sky-800"
          role="status"
        >
          当前是在线只读预览：技能目录正常展示，但新建、导入、编辑、启停、校验和保存均不可用。
          本地部署后可管理完整技能正文、版本和资源，
          <LocalDeployGuideLink className="ml-1" />
        </div>
      ) : null}
      {owner ? (
        <p className="mb-3 text-xs text-(--tw-label-secondary)">
          当前仅显示推荐给该功能的技能。
          <button
            className="ml-2 text-(--tw-accent)"
            onClick={() => {
              setOwner('');
              const url = new URL(location.href);
              url.searchParams.delete('owner');
              history.replaceState(null, '', url);
            }}
          >
            查看全部技能
          </button>
        </p>
      ) : null}
      {error ? (
        <div
          role="alert"
          className="mb-3 rounded-lg border border-red-300 p-3 text-sm text-red-600"
        >
          {error}
          <button
            className="ml-3 underline"
            onClick={() =>
              void action(async () => {
                await skillRequest('migrate');
                await refresh();
              })
            }
          >
            重试加载
          </button>
        </div>
      ) : null}
      {loading ? <p role="status">正在准备当前空间技能…</p> : null}
      {!loading && visible.length ? (
        <div className="mb-2 flex items-center gap-2">
          <h3 className="text-sm font-semibold">已安装</h3>
          <span className="text-xs text-(--tw-label-tertiary)">{groups.length}</span>
        </div>
      ) : null}
      {creating ? (
        <div className="mb-4 space-y-3 rounded-xl border border-(--tw-border) p-4">
          <h3 className="font-semibold">新建技能</h3>
          <input
            aria-label="技能名称"
            placeholder="技能名称"
            className={field}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <textarea
            aria-label="技能业务规则"
            placeholder="填写提示词和业务规则；创建后可以继续维护流程。"
            className={field}
            rows={8}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <div className="flex gap-2">
            <button
              className={button}
              disabled={busy || readOnly || !name.trim() || !body.trim()}
              onClick={() =>
                void action(async () => {
                  const data = await skillRequest<{ skill: SkillDetail }>('create', {
                    name,
                    content: body,
                  });
                  await refresh();
                  await open(data.skill.id);
                  showToast('技能已创建', 'success');
                })
              }
            >
              创建
            </button>
            <button className={button} onClick={() => setCreating(false)}>
              取消
            </button>
          </div>
        </div>
      ) : null}
      {detail ? (
        <Dialog open onClose={() => setDetail(null)} className="relative z-110">
          <DialogBackdrop
            transition
            className="tw-dialog-backdrop-anim fixed inset-0 bg-black/35"
            aria-hidden="true"
          />
          <div className="fixed inset-0 flex items-center justify-center p-4">
            <DialogPanel
              transition
              className="tw-dialog-panel-anim flex max-h-[min(88vh,900px)] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-(--tw-border) bg-(--tw-surface-panel) shadow-2xl"
            >
              <div className="flex shrink-0 items-start gap-4 border-b border-(--tw-border) p-5">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <DialogTitle as="h2" className="text-lg font-semibold">
                      {detail.name}
                    </DialogTitle>
                    <span className="rounded-full border border-(--tw-border) px-2 py-0.5 text-[11px] text-(--tw-label-tertiary)">
                      v{detail.version}
                    </span>
                  </div>
                  <DialogDescription className="mt-1 max-w-3xl text-sm leading-6 text-(--tw-label-secondary)">
                    {detailDescription}
                  </DialogDescription>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span className="rounded-full border border-(--tw-border) px-2 py-0.5 text-[11px] text-(--tw-label-tertiary)">
                      {detailIsSystem ? '系统技能' : '用户技能'}
                    </span>
                    <span className="rounded-full border border-(--tw-border) px-2 py-0.5 text-[11px] text-(--tw-label-tertiary)">
                      {detailVariants.length} 个变体
                    </span>
                    {detailPluginRefs.map((id) => (
                      <span
                        key={id}
                        className="rounded-full bg-(--tw-accent-soft) px-2 py-0.5 text-[11px] text-(--tw-accent)"
                      >
                        推荐给 {pluginLabel(id)}
                      </span>
                    ))}
                  </div>
                  <div className="mt-2">
                    {detail.kind !== 'foundation' ? (
                      <a
                        className="text-xs text-(--tw-accent)"
                        href={`/workbench/?skill=${encodeURIComponent('space:' + detail.id)}`}
                      >
                        在工作台使用此技能
                      </a>
                    ) : (
                      <span className="text-xs text-(--tw-label-tertiary)">
                        当前空间常驻规则，无需重复关联
                      </span>
                    )}
                  </div>
                </div>
                <button
                  aria-label="关闭技能详情"
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-xl leading-none text-(--tw-label-tertiary) hover:bg-(--tw-surface-recessed) hover:text-(--tw-label-primary)"
                  onClick={() => setDetail(null)}
                >
                  ✕
                </button>
              </div>
              <div className="min-h-0 overflow-y-auto p-5">
                {detailVariants.length > 1 ? (
                  <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-(--tw-border) p-3">
                    <div className="min-w-0 flex-1">
                      <span className="block text-xs font-medium">当前变体</span>
                      <span className="block text-xs text-(--tw-label-tertiary)">
                        同一技能的规则或场景配置，编辑和版本独立保存。
                      </span>
                    </div>
                    <SelectDropdown
                      compact
                      ariaLabel="选择技能变体"
                      value={detail.id}
                      onChange={(id) => void open(id)}
                      options={detailVariants.map((item) => ({
                        value: item.id,
                        label: item.variant,
                      }))}
                      className="w-full sm:w-72"
                    />
                  </div>
                ) : null}
                <div className="mb-3 flex flex-wrap gap-2">
                  {[
                    ['rules', '业务规则'],
                    ['workflow', '流程'],
                    ['resources', '资源与关联'],
                    ['validate', '输出校验'],
                  ].map(([key, label]) => (
                    <button
                      className={
                        button +
                        (section === key ? ' bg-(--tw-accent-soft) text-(--tw-accent)' : '')
                      }
                      key={key}
                      onClick={() => setSection(key)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {section === 'rules' ? (
                  <textarea
                    aria-label="编辑技能业务规则"
                    className={field + ' font-mono'}
                    rows={14}
                    value={detail.content}
                    readOnly={readOnly}
                    onChange={(e) => setDetail({ ...detail, content: e.target.value })}
                  />
                ) : null}
                {section === 'workflow' ? (
                  <textarea
                    aria-label="编辑技能流程"
                    className={field + ' font-mono'}
                    rows={14}
                    value={detail.instructions}
                    readOnly={readOnly}
                    onChange={(e) => setDetail({ ...detail, instructions: e.target.value })}
                  />
                ) : null}
                {section === 'resources' ? (
                  <div className="space-y-2 text-sm">
                    <p>{detail.description}</p>
                    <p>
                      推荐给：
                      {detailPluginRefs.length
                        ? detailPluginRefs.map(pluginLabel).join('、')
                        : '未关联业务插件'}
                    </p>
                    <p>当前变体：{detail.variant}</p>
                    <p>兼容旧引用：{detail.legacyPath || '无'}</p>
                    {detail.resources.map((x) => (
                      <p key={x} className="font-mono text-xs">
                        {x}
                      </p>
                    ))}
                    <p className="text-xs text-(--tw-label-secondary)">
                      原文件作为迁移备份保留；业务读取与本页编辑使用同一份技能正文。校验脚本可独立读取标准输入
                      JSON；不会自动运行。
                    </p>
                    <button
                      className={button}
                      onClick={() => {
                        const blob = new Blob(
                          [detail.instructions + '\n\n## 业务规则\n' + detail.content],
                          { type: 'text/markdown' },
                        );
                        const url = URL.createObjectURL(blob),
                          a = document.createElement('a');
                        a.href = url;
                        a.download = detail.id + '-SKILL.md';
                        a.click();
                        URL.revokeObjectURL(url);
                      }}
                    >
                      导出技能说明
                    </button>
                    <button
                      className={button}
                      disabled={busy || readOnly}
                      onClick={() =>
                        void action(async () => {
                          const data = await skillRequest<{ bundle: unknown }>('export', {
                            id: detail.id,
                          });
                          const url = URL.createObjectURL(
                            new Blob([JSON.stringify(data.bundle, null, 2)], {
                              type: 'application/json',
                            }),
                          );
                          const a = document.createElement('a');
                          a.href = url;
                          a.download = detail.id + '.json';
                          a.click();
                          URL.revokeObjectURL(url);
                        })
                      }
                    >
                      导出完整技能包
                    </button>
                  </div>
                ) : null}
                {section === 'validate' ? (
                  <div className="space-y-3">
                    <p className="text-xs text-(--tw-label-secondary)">
                      校验已有输出，不调用模型、不写业务数据。填写 rows、模板 columns、合法
                      sourceIds，可选 enums、stats。未提供的检查条件会明确提示。
                    </p>
                    <textarea
                      aria-label="输出校验JSON"
                      className={field + ' font-mono'}
                      rows={9}
                      value={input}
                      readOnly={readOnly}
                      onChange={(e) => setInput(e.target.value)}
                    />
                    <button
                      className={button}
                      disabled={busy || readOnly}
                      onClick={() =>
                        void action(async () => {
                          const data = await skillRequest('validate', {
                            id: detail.id,
                            input: JSON.parse(input),
                          });
                          setResult(JSON.stringify(data, null, 2));
                        })
                      }
                    >
                      运行校验
                    </button>
                    {result ? (
                      <pre
                        className="max-h-64 overflow-auto rounded-lg bg-(--tw-surface-recessed) p-3 text-xs"
                        role="status"
                      >
                        {result}
                      </pre>
                    ) : null}
                  </div>
                ) : null}
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-(--tw-border) p-4">
                <button
                  className={button + ' bg-(--tw-accent) text-white'}
                  disabled={busy || readOnly}
                  onClick={() =>
                    void action(async () => {
                      const data = await skillRequest<{ skill: SkillDetail }>('save', {
                        id: detail.id,
                        patch: {
                          content: detail.content,
                          instructions: detail.instructions,
                          hash: detail.hash,
                        },
                      });
                      setDetail(data.skill);
                      await refresh();
                      const h = await skillRequest<{ versions: number[] }>('history', {
                        id: detail.id,
                      });
                      setVersions(h.versions);
                      setVersion(h.versions[0]?.toString() || '');
                      showToast('技能已保存，后续任务使用新版本', 'success');
                    })
                  }
                >
                  保存技能
                </button>
                {versions.length ? (
                  <>
                    <SelectDropdown
                      compact
                      ariaLabel="历史技能版本"
                      value={version}
                      onChange={setVersion}
                      options={versions.map((v) => ({ value: String(v), label: `恢复到 v${v}` }))}
                    />
                    <button
                      className={button}
                      disabled={busy || readOnly || !version}
                      onClick={() =>
                        void action(async () => {
                          const data = await skillRequest<{ skill: SkillDetail }>('restore', {
                            id: detail.id,
                            version: Number(version),
                            hash: detail.hash,
                          });
                          await open(data.skill.id);
                          await refresh();
                          showToast('已恢复内容并创建新版本', 'success');
                        })
                      }
                    >
                      恢复版本
                    </button>
                  </>
                ) : null}
              </div>
            </DialogPanel>
          </div>
        </Dialog>
      ) : null}
      {!loading && !visible.length ? (
        <p className="p-8 text-center text-sm text-(--tw-label-tertiary)">
          没有匹配的技能，可以新建或调整搜索词。
        </p>
      ) : null}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
        {groups.map((group) => {
          const entries = visible.filter((x) => x.group === group);
          const first = entries[0];
          const primary =
            entries.find((entry) => !entry.description.startsWith('旧版变体')) || first;
          const enabled = entries.every((entry) => entry.enabled);
          const mixed = !enabled && entries.some((entry) => entry.enabled);
          const foundation = entries.some((entry) => entry.foundation);
          const businessLinked = entries.some(
            (entry) => entry.pluginRefs?.length > 0 || Boolean(entry.owner),
          );
          const locked = foundation || businessLinked;
          const refs = [
            ...new Set(
              entries.flatMap((entry) =>
                entry.pluginRefs?.length ? entry.pluginRefs : entry.owner ? [entry.owner] : [],
              ),
            ),
          ];
          return (
            <article
              key={group}
              className="min-w-0 cursor-pointer rounded-xl border border-(--tw-border) bg-(--tw-surface-panel) p-4 transition-colors hover:border-(--tw-accent)"
              onClick={(event) => {
                if ((event.target as HTMLElement).closest('button, a')) return;
                void open(primary.id);
              }}
            >
              <div className="flex min-w-0 items-start gap-3">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-start gap-3 text-left"
                  aria-haspopup="dialog"
                  onClick={() => void open(primary.id)}
                >
                  <SkillGlyph />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{primary.name}</span>
                    <span className="mt-1 line-clamp-2 block text-sm leading-5 text-(--tw-label-secondary)">
                      {primary.description}
                    </span>
                    <span className="mt-2 flex flex-wrap gap-1.5 text-[11px] text-(--tw-label-tertiary)">
                      <span className="rounded-full border border-(--tw-border) px-2 py-0.5">
                        {entries.length} 个变体
                      </span>
                      {refs.map((id) => (
                        <span
                          key={id}
                          className="rounded-full border border-(--tw-border) px-2 py-0.5"
                        >
                          {pluginLabel(id)}
                        </span>
                      ))}
                      {locked ? (
                        <span className="rounded-full border border-(--tw-border) px-2 py-0.5">
                          常驻启用
                        </span>
                      ) : null}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  role="switch"
                  aria-checked={mixed ? 'mixed' : enabled}
                  aria-busy={togglingGroup === group || undefined}
                  aria-label={
                    foundation
                      ? `${primary.name} 空间基础规则常驻启用`
                      : businessLinked
                        ? `${primary.name} 已关联业务，常驻启用`
                        : `${enabled ? '停用' : '启用'} ${primary.name}`
                  }
                  title={
                    readOnly
                      ? '在线只读预览，请本地部署后调整技能启停'
                      : foundation
                        ? '空间基础规则常驻，不能停用'
                        : businessLinked
                          ? '已关联业务，不能停用'
                          : undefined
                  }
                  className="tw-toggle disabled:cursor-not-allowed disabled:opacity-45"
                  disabled={togglingGroup === group || locked || readOnly}
                  onClick={(event) => {
                    event.stopPropagation();
                    void toggleSkillGroup(group, !enabled);
                  }}
                >
                  <span className="tw-toggle-knob" />
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

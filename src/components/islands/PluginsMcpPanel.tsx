/**
 * 「我的插件 → MCP」：列出 / 添加 / 编辑 / 删除当前空间 mcp.json 里的服务器。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';
import {
  TENCENT_DOCS_MCP,
  deleteMcpServerConfig,
  fetchMcpServers,
  parseMcpServersJson,
  reloadMcpClients,
  serverToMcpServersJson,
  upsertMcpServerConfig,
  type McpServerConfig,
  type McpServerTransport,
} from '../../lib/mcp-tools';
import { showToast } from './Toast';

type McpListRow = McpServerConfig & {
  /** 内置腾讯文档占位：尚未写入 mcp.json */
  pending?: boolean;
  displayName?: string;
};

type EditorMode = 'create' | 'edit' | 'tencent';
type EditorView = 'form' | 'json';

type EditorState = {
  mode: EditorMode;
  view: EditorView;
  previousName?: string;
  name: string;
  transport: McpServerTransport;
  url: string;
  command: string;
  argsText: string;
  authHeader: string;
  /** stdio env：每行 KEY=VALUE */
  envText: string;
  jsonText: string;
};

function envToText(env?: Record<string, string>): string {
  if (!env) return '';
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

function textToEnv(text: string): Record<string, string> | undefined {
  /** @type {Record<string, string>} */
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const i = trimmed.indexOf('=');
    if (i <= 0) continue;
    out[trimmed.slice(0, i).trim()] = trimmed.slice(i + 1).trim();
  }
  return Object.keys(out).length ? out : undefined;
}

function formSnapshot(e: EditorState) {
  const headers: Record<string, string> = {};
  if (e.authHeader.trim()) headers.Authorization = e.authHeader.trim();
  return {
    name: e.name.trim() || (e.mode === 'tencent' ? TENCENT_DOCS_MCP.name : 'mcp'),
    transport: e.transport,
    command: e.command,
    args: e.argsText.trim().split(/\s+/).filter(Boolean),
    env: textToEnv(e.envText),
    url: e.url,
    headers: Object.keys(headers).length ? headers : undefined,
  };
}

function emptyEditor(mode: EditorMode = 'create'): EditorState {
  const base =
    mode === 'tencent'
      ? {
          mode,
          view: 'form' as const,
          name: TENCENT_DOCS_MCP.name,
          transport: 'http' as const,
          url: TENCENT_DOCS_MCP.url,
          command: '',
          argsText: '',
          authHeader: '',
          envText: '',
          jsonText: '',
        }
      : {
          mode,
          view: 'form' as const,
          name: '',
          transport: 'http' as const,
          url: '',
          command: '',
          argsText: '',
          authHeader: '',
          envText: '',
          jsonText: '',
        };
  return { ...base, jsonText: serverToMcpServersJson(formSnapshot(base)) };
}

function fromServer(s: McpServerConfig): EditorState {
  const state: EditorState = {
    mode: 'edit',
    view: 'form',
    previousName: s.name,
    name: s.name,
    transport: s.transport === 'stdio' ? 'stdio' : 'http',
    url: s.url || '',
    command: s.command || '',
    argsText: Array.isArray(s.args) ? s.args.join(' ') : '',
    authHeader: s.headers?.Authorization || s.headers?.authorization || '',
    envText: envToText(s.env),
    jsonText: '',
  };
  state.jsonText = serverToMcpServersJson(formSnapshot(state));
  return state;
}

function applyParsedToEditor(
  editor: EditorState,
  parsed: {
    name: string;
    transport: McpServerTransport;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
  },
): EditorState {
  return {
    ...editor,
    name: parsed.name,
    transport: parsed.transport,
    command: parsed.command || '',
    argsText: Array.isArray(parsed.args) ? parsed.args.join(' ') : '',
    envText: envToText(parsed.env),
    url: parsed.url || '',
    authHeader: parsed.headers?.Authorization || parsed.headers?.authorization || '',
  };
}

type Props = {
  onServersChange?: (count: number) => void;
};

export default function PluginsMcpPanel({ onServersChange }: Props) {
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [path, setPath] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  /** 已有列表时的后台刷新：不卸表，避免闪「加载中」 */
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [connectingName, setConnectingName] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const editorSnap = useRef<EditorState | null>(null);
  if (editor) editorSnap.current = editor;
  const editorView = editor ?? editorSnap.current;
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const deleteSnap = useRef<string | null>(null);
  if (confirmDelete) deleteSnap.current = confirmDelete;
  const deleteName = confirmDelete ?? deleteSnap.current;

  const refresh = useCallback(
    async (opts?: { silent?: boolean }) => {
      const silent = Boolean(opts?.silent);
      if (silent) setRefreshing(true);
      else setLoading(true);
      try {
        const data = await fetchMcpServers();
        setServers(data.servers);
        setPath(data.path || '');
        setErrors(data.errors || (data.error ? [data.error] : []));
        onServersChange?.(data.servers.length);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [onServersChange],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function switchEditorView(next: EditorView) {
    if (!editor || editor.view === next) return;
    if (next === 'json') {
      setEditor({
        ...editor,
        view: 'json',
        jsonText: serverToMcpServersJson(formSnapshot(editor)),
      });
      return;
    }
    const parsed = parseMcpServersJson(editor.jsonText);
    if (!parsed.ok) {
      showToast(parsed.error, 'error');
      return;
    }
    if (parsed.servers.length > 1 && editor.mode === 'edit') {
      showToast('编辑时 JSON 里请只保留一台服务器', 'error');
      return;
    }
    setEditor({
      ...applyParsedToEditor(editor, parsed.servers[0]!),
      view: 'form',
      jsonText: editor.jsonText,
    });
  }

  async function handleSave() {
    if (!editor) return;
    setBusy(true);
    try {
      let list: Array<{
        name: string;
        transport: McpServerTransport;
        command?: string;
        args?: string[];
        env?: Record<string, string>;
        url?: string;
        headers?: Record<string, string>;
      }>;

      if (editor.view === 'json') {
        const parsed = parseMcpServersJson(editor.jsonText);
        if (!parsed.ok) {
          showToast(parsed.error, 'error');
          return;
        }
        if (parsed.servers.length > 1 && editor.mode === 'edit') {
          showToast('编辑时 JSON 里请只保留一台服务器', 'error');
          return;
        }
        list = parsed.servers;
      } else {
        const snap = formSnapshot(editor);
        const name = snap.name.trim();
        if (!name) {
          showToast('请填写名称', 'error');
          return;
        }
        if (editor.mode === 'tencent' && !editor.authHeader.trim()) {
          showToast('请粘贴腾讯文档 MCP Token', 'error');
          return;
        }
        if (snap.transport === 'stdio' && !snap.command.trim()) {
          showToast('stdio 需要填写 command', 'error');
          return;
        }
        if (snap.transport === 'http' && !snap.url.trim()) {
          showToast('HTTP 需要填写 URL', 'error');
          return;
        }
        list = [
          snap.transport === 'stdio'
            ? {
                name,
                transport: 'stdio',
                command: snap.command.trim(),
                args: snap.args,
                env: snap.env,
              }
            : {
                name,
                transport: 'http',
                url: snap.url.trim(),
                headers: snap.headers,
              },
        ];
      }

      let lastError = '';
      for (let i = 0; i < list.length; i++) {
        const payload = list[i]!;
        const previousName = editor.mode === 'edit' && i === 0 ? editor.previousName : undefined;
        const res = await upsertMcpServerConfig(payload, previousName);
        if (!res.ok) {
          lastError = res.error || '保存失败';
          break;
        }
      }
      if (lastError) {
        showToast(lastError, 'error');
        await refresh({ silent: true });
        return;
      }
      setEditor(null);
      showToast(
        list.length > 1 ? `已保存 ${list.length} 台并重新连接` : '已保存并重新连接',
        'success',
      );
      await refresh({ silent: true });
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(name: string) {
    setBusy(true);
    try {
      const res = await deleteMcpServerConfig(name);
      if (!res.ok) {
        showToast(res.error || '删除失败', 'error');
        return;
      }
      setConfirmDelete(null);
      showToast('已删除', 'success');
      await refresh({ silent: true });
    } finally {
      setBusy(false);
    }
  }

  async function handleReload(name?: string) {
    if (name) setConnectingName(name);
    else setBusy(true);
    try {
      const res = await reloadMcpClients(name);
      if (!res.ok) {
        showToast(res.error || '连接失败', 'error');
        return;
      }
      const serverErr = res.errors?.find((e) => (name ? e.startsWith(`${name}:`) : true));
      if (serverErr) {
        showToast(serverErr, 'error');
      } else if (name) {
        const ok = res.connected?.includes(name);
        showToast(ok ? `「${name}」已连接` : `「${name}」未连上`, ok ? 'success' : 'error');
      } else if (res.errors?.length) {
        showToast(res.errors[0]!, 'error');
      } else {
        showToast(name ? '已重新连接' : '刷新成功', 'success');
      }
      await refresh({ silent: true });
    } finally {
      setConnectingName(null);
      setBusy(false);
    }
  }

  const rows = useMemo((): McpListRow[] => {
    const hasTencent = servers.some((s) => s.name === TENCENT_DOCS_MCP.name);
    const rest = servers.filter((s) => s.name !== TENCENT_DOCS_MCP.name);
    const tencentRow: McpListRow = hasTencent
      ? {
          ...servers.find((s) => s.name === TENCENT_DOCS_MCP.name)!,
          displayName: '腾讯文档',
        }
      : {
          name: TENCENT_DOCS_MCP.name,
          displayName: '腾讯文档',
          transport: 'http',
          url: TENCENT_DOCS_MCP.url,
          pending: true,
          connected: false,
          toolCount: 0,
        };
    return [tencentRow, ...rest];
  }, [servers]);

  const showInitialLoading = loading && servers.length === 0;

  return (
    <div className="mt-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy || refreshing}
          onClick={() => setEditor(emptyEditor('create'))}
          className="h-8 rounded-lg bg-[#4176e6] px-3 text-[13px] font-medium text-white hover:bg-[#3566cc] disabled:opacity-60"
        >
          添加 MCP
        </button>
        <button
          type="button"
          disabled={busy || loading || refreshing}
          onClick={() => void handleReload()}
          className="h-8 rounded-lg border border-stone-200 bg-white px-3 text-[13px] text-stone-600 hover:bg-stone-50 disabled:opacity-60"
        >
          {refreshing && !connectingName ? '刷新中…' : '刷新连接'}
        </button>
        {path ? (
          <span
            className="ml-auto max-w-full truncate font-mono text-[11px] text-stone-400"
            title={path}
          >
            {path}
          </span>
        ) : null}
      </div>

      {errors.length ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] leading-5 text-amber-800">
          {errors.map((e) => (
            <p key={e}>{e}</p>
          ))}
        </div>
      ) : null}

      {showInitialLoading ? (
        <p className="py-10 text-center text-sm text-stone-400">加载中…</p>
      ) : (
        <div
          className={`overflow-x-auto rounded-xl border border-stone-200 bg-white transition-opacity duration-150 ${
            refreshing ? 'opacity-70' : 'opacity-100'
          }`}
        >
          <table className="w-full min-w-[640px] border-collapse text-left text-[13px]">
            <thead>
              <tr className="border-b border-stone-100 bg-stone-50/80 text-[12px] text-stone-500">
                <th className="px-3 py-2.5 font-medium">名称</th>
                <th className="w-20 px-3 py-2.5 font-medium">类型</th>
                <th className="px-3 py-2.5 font-medium">地址 / 命令</th>
                <th className="w-16 px-3 py-2.5 font-medium tabular-nums">工具</th>
                <th className="w-24 px-3 py-2.5 font-medium">状态</th>
                <th className="w-32 px-3 py-2.5 font-medium text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const endpoint =
                  s.transport === 'stdio'
                    ? [s.command, ...(s.args || [])].filter(Boolean).join(' ')
                    : s.url || '';
                return (
                  <tr
                    key={s.name}
                    className="border-b border-stone-100 last:border-b-0 hover:bg-stone-50/70"
                  >
                    <td className="max-w-[10rem] px-3 py-2.5">
                      <div className="truncate font-medium text-stone-900">
                        {s.displayName || s.name}
                      </div>
                      <div className="mt-0.5 truncate font-mono text-[11px] text-stone-400">
                        {s.name}
                        {s.pending ? ' · 待配置' : s.hasSecrets ? ' · 已配置密钥' : ''}
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className="rounded border border-stone-200 px-1.5 py-0.5 text-[11px] uppercase text-stone-400">
                        {s.transport}
                      </span>
                    </td>
                    <td className="max-w-[18rem] px-3 py-2.5">
                      <span
                        className="block truncate font-mono text-[12px] text-stone-500"
                        title={endpoint}
                      >
                        {endpoint || '—'}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 tabular-nums text-stone-600">
                      {s.pending ? '—' : (s.toolCount ?? 0)}
                    </td>
                    <td className="px-3 py-2.5">
                      {s.pending ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setEditor(emptyEditor('tencent'))}
                          className="rounded-md bg-amber-50 px-2 py-0.5 text-[12px] text-amber-700 hover:bg-amber-100"
                        >
                          需配置
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={busy || connectingName !== null || refreshing}
                          onClick={() => void handleReload(s.name)}
                          className={`rounded-md px-2 py-0.5 text-[12px] transition-colors ${
                            connectingName === s.name
                              ? 'bg-sky-50 text-sky-700'
                              : s.connected
                                ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                                : 'bg-stone-100 text-stone-600 hover:bg-[#4176e6]/10 hover:text-[#4176e6]'
                          } disabled:opacity-60`}
                        >
                          {connectingName === s.name ? '连接中…' : s.connected ? '已连接' : '连接'}
                        </button>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center justify-end gap-3">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            setEditor(s.pending ? emptyEditor('tencent') : fromServer(s))
                          }
                          className="text-[13px] text-[#4176e6] hover:underline disabled:opacity-60"
                        >
                          {s.pending ? '配置' : '编辑'}
                        </button>
                        {s.pending ? null : (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => setConfirmDelete(s.name)}
                            className="text-[13px] text-rose-600 hover:underline disabled:opacity-60"
                          >
                            删除
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Dialog
        open={Boolean(editor)}
        onClose={() => {
          if (!busy) setEditor(null);
        }}
        className="relative z-110"
      >
        <DialogBackdrop
          transition
          className="tw-dialog-backdrop-anim fixed inset-0 bg-black/30"
          aria-hidden="true"
        />
        <div className="fixed inset-0 flex items-center justify-center p-4">
          <DialogPanel
            transition
            className="tw-dialog-panel-anim flex max-h-[85vh] w-full max-w-lg flex-col rounded-xl border border-stone-200 bg-white p-5 shadow-xl"
          >
            {editorView ? (
              <>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <DialogTitle className="text-[15px] font-semibold text-stone-900">
                      {editorView.mode === 'tencent'
                        ? '配置腾讯文档 MCP'
                        : editorView.mode === 'edit'
                          ? '编辑 MCP'
                          : '添加 MCP'}
                    </DialogTitle>
                    {editorView.mode === 'tencent' ? (
                      <p className="mt-1.5 text-[12px] leading-5 text-stone-500">
                        在腾讯文档空间菜单「使用 MCP」复制 Token，粘贴到下方。Token
                        约一年有效，有日调用限额。
                      </p>
                    ) : editorView.view === 'json' ? (
                      <p className="mt-1.5 text-[12px] leading-5 text-stone-500">
                        可粘贴 Trae / Claude Desktop 的 mcpServers JSON，也支持灵光 servers[]。
                      </p>
                    ) : null}
                  </div>
                  <div className="tw-plugins-pills shrink-0" role="group" aria-label="编辑方式">
                    <button
                      type="button"
                      aria-pressed={editorView.view === 'form'}
                      onClick={() => switchEditorView('form')}
                    >
                      表单
                    </button>
                    <button
                      type="button"
                      aria-pressed={editorView.view === 'json'}
                      onClick={() => switchEditorView('json')}
                    >
                      JSON
                    </button>
                  </div>
                </div>

                {editorView.view === 'json' ? (
                  <div className="mt-4 min-h-0 flex-1">
                    <textarea
                      value={editorView.jsonText}
                      onChange={(e) => editor && setEditor({ ...editor, jsonText: e.target.value })}
                      spellCheck={false}
                      className="h-72 w-full resize-y rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 font-mono text-[12px] leading-5 text-stone-800 outline-none focus:border-[#4176e6]"
                      placeholder={`{\n  "mcpServers": {\n    "demo": {\n      "command": "npx",\n      "args": ["-y", "some-mcp-server"],\n      "env": {}\n    }\n  }\n}`}
                    />
                  </div>
                ) : (
                  <div className="mt-4 space-y-3 overflow-y-auto">
                    <Field label="名称">
                      <input
                        value={editorView.name}
                        disabled={editorView.mode === 'tencent'}
                        onChange={(e) => editor && setEditor({ ...editor, name: e.target.value })}
                        className="h-9 w-full rounded-lg border border-stone-200 bg-white px-3 text-[13px] text-stone-800 outline-none focus:border-[#4176e6]"
                        placeholder="tencent-docs"
                      />
                    </Field>
                    {editorView.mode === 'tencent' ? null : (
                      <Field label="传输">
                        <div className="flex gap-2">
                          {(['http', 'stdio'] as const).map((t) => (
                            <button
                              key={t}
                              type="button"
                              aria-pressed={editorView.transport === t}
                              onClick={() => editor && setEditor({ ...editor, transport: t })}
                              className={`h-8 rounded-md border px-3 text-[12px] ${
                                editorView.transport === t
                                  ? 'border-[#4176e6] bg-[#4176e6]/10 text-[#4176e6]'
                                  : 'border-stone-200 text-stone-600'
                              }`}
                            >
                              {t}
                            </button>
                          ))}
                        </div>
                      </Field>
                    )}
                    {editorView.transport === 'http' ? (
                      <>
                        <Field label="URL">
                          <input
                            value={editorView.url}
                            disabled={editorView.mode === 'tencent'}
                            onChange={(e) =>
                              editor && setEditor({ ...editor, url: e.target.value })
                            }
                            className="h-9 w-full rounded-lg border border-stone-200 bg-white px-3 text-[13px] text-stone-800 outline-none focus:border-[#4176e6]"
                            placeholder="https://…"
                          />
                        </Field>
                        <Field
                          label={
                            editorView.mode === 'tencent'
                              ? 'MCP Token（Authorization）'
                              : 'Authorization'
                          }
                        >
                          <input
                            value={editorView.authHeader}
                            onChange={(e) =>
                              editor && setEditor({ ...editor, authHeader: e.target.value })
                            }
                            className="h-9 w-full rounded-lg border border-stone-200 bg-white px-3 text-[13px] text-stone-800 outline-none focus:border-[#4176e6]"
                            placeholder={
                              editorView.mode === 'edit' && editorView.authHeader.startsWith('••••')
                                ? '留脱敏值表示不改密钥'
                                : '粘贴 Token'
                            }
                            autoComplete="off"
                          />
                        </Field>
                      </>
                    ) : (
                      <>
                        <Field label="command">
                          <input
                            value={editorView.command}
                            onChange={(e) =>
                              editor && setEditor({ ...editor, command: e.target.value })
                            }
                            className="h-9 w-full rounded-lg border border-stone-200 bg-white px-3 text-[13px] text-stone-800 outline-none focus:border-[#4176e6]"
                            placeholder="npx"
                          />
                        </Field>
                        <Field label="args（空格分隔）">
                          <input
                            value={editorView.argsText}
                            onChange={(e) =>
                              editor && setEditor({ ...editor, argsText: e.target.value })
                            }
                            className="h-9 w-full rounded-lg border border-stone-200 bg-white px-3 text-[13px] text-stone-800 outline-none focus:border-[#4176e6]"
                            placeholder="-y some-mcp-server"
                          />
                        </Field>
                        <Field label="env（每行 KEY=VALUE）">
                          <textarea
                            value={editorView.envText}
                            onChange={(e) =>
                              editor && setEditor({ ...editor, envText: e.target.value })
                            }
                            spellCheck={false}
                            rows={3}
                            className="w-full resize-y rounded-lg border border-stone-200 bg-white px-3 py-2 font-mono text-[12px] text-stone-800 outline-none focus:border-[#4176e6]"
                            placeholder="TAVILY_API_KEY=…"
                          />
                        </Field>
                      </>
                    )}
                  </div>
                )}
                <div className="mt-5 flex justify-end gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setEditor(null)}
                    className="h-9 rounded-lg border border-stone-200 px-3 text-[13px] text-stone-600"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleSave()}
                    className="h-9 rounded-lg bg-[#4176e6] px-3 text-[13px] font-medium text-white disabled:opacity-60"
                  >
                    {busy ? '保存中…' : '保存'}
                  </button>
                </div>
              </>
            ) : null}
          </DialogPanel>
        </div>
      </Dialog>

      <Dialog
        open={Boolean(confirmDelete)}
        onClose={() => {
          if (!busy) setConfirmDelete(null);
        }}
        className="relative z-110"
      >
        <DialogBackdrop
          transition
          className="tw-dialog-backdrop-anim fixed inset-0 bg-black/30"
          aria-hidden="true"
        />
        <div className="fixed inset-0 flex items-center justify-center p-4">
          <DialogPanel
            transition
            className="tw-dialog-panel-anim w-full max-w-sm rounded-xl border border-stone-200 bg-white p-5 shadow-xl"
          >
            <DialogTitle className="text-[15px] font-semibold text-stone-900">
              删除 MCP？
            </DialogTitle>
            <p className="mt-2 text-[13px] text-stone-500">
              将从当前空间配置中移除「{deleteName}」，对话里对应工具会立即消失。
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirmDelete(null)}
                className="h-9 rounded-lg border border-stone-200 px-3 text-[13px] text-stone-600"
              >
                取消
              </button>
              <button
                type="button"
                disabled={busy || !deleteName}
                onClick={() => deleteName && void handleDelete(deleteName)}
                className="h-9 rounded-lg bg-rose-600 px-3 text-[13px] font-medium text-white disabled:opacity-60"
              >
                删除
              </button>
            </div>
          </DialogPanel>
        </div>
      </Dialog>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[12px] text-stone-500">{label}</span>
      {children}
    </label>
  );
}

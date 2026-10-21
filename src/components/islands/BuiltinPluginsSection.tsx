/**
 * 内置插件（会话 / 全局）面板。
 *
 * 这些能力由平台按会话或全局提供，没有开关：以前塞在「我的插件」里当两个 Tab，
 * 和可配置的扩展插件混在一起，容易被误以为也能关掉。现在统一收进设置页的
 * 「内置插件」入口，这里只展示「是什么 + 当前是否就绪」。
 *
 * 就绪判断只看本机服务探测（网页 / 文件 / bash / pwsh），探测不到就标「需本地服务」。
 */
import { useEffect, useState } from 'react';
import {
  GLOBAL_PLUGIN_CATALOG,
  SESSION_PLUGIN_CATALOG,
  builtinRuntimeKey,
  type BuiltinCatalogEntry,
} from '../../lib/builtin-plugin-catalog';
import { fetchWebHealth, type WebHealth } from '../../lib/web-tools';
import { fetchFsHealth, type FsHealth } from '../../lib/fs-tools';
import {
  fetchBashHealth,
  fetchPwshHealth,
  type BashHealth,
  type PwshHealth,
} from '../../lib/bash-tools';

type Tone = 'ready' | 'warn' | 'plan';
type Status = { label: string; tone: Tone };

/** 去掉对照体系残留字样，避免出现在产品页 */
function displayRole(text: string): string {
  return String(text ?? '')
    .replace(/（\s*dsh[^）]*）/gi, '')
    .replace(/\(\s*dsh[^)]*\)/gi, '')
    .replace(/\bdsh\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/（\s*）/g, '')
    .trim();
}

function StatusPill({ status }: { status: Status }) {
  const cls =
    status.tone === 'ready'
      ? 'bg-emerald-50 text-emerald-700 border-emerald-100'
      : status.tone === 'warn'
        ? 'bg-amber-50 text-amber-800 border-amber-100'
        : 'bg-stone-100 text-stone-500 border-stone-200';
  return (
    <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[11px] ${cls}`}>
      {status.label}
    </span>
  );
}

function Dot({ tone }: { tone: Tone }) {
  const cls =
    tone === 'ready' ? 'bg-emerald-500' : tone === 'warn' ? 'bg-amber-500' : 'bg-stone-300';
  return <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${cls}`} />;
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden="true"
      className={`h-3.5 w-3.5 shrink-0 text-stone-400 transition-transform duration-150 ${
        open ? 'rotate-90' : ''
      }`}
      viewBox="0 0 20 20"
      fill="currentColor"
    >
      <path
        fillRule="evenodd"
        d="M7.21 14.77a.75.75 0 01.02-1.06L11.17 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z"
        clipRule="evenodd"
      />
    </svg>
  );
}

export default function BuiltinPluginsSection() {
  const [web, setWeb] = useState<WebHealth | null>(null);
  const [fs, setFs] = useState<FsHealth | null>(null);
  const [bash, setBash] = useState<BashHealth | null>(null);
  const [pwsh, setPwsh] = useState<PwshHealth | null>(null);
  const [probing, setProbing] = useState(true);
  const [query, setQuery] = useState('');
  /** 会话 / 全局两个分组各自可收起（默认展开） */
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  /** 单张卡片展开后显示分类与 npm 包；默认收起。
   *  会话 / 全局两个分组里有 22 个同名能力（agent-instructions、tool-bash…），
   *  只按 id 记状态会把两个分组的同名卡片一起展开，所以 key 带上分组前缀。 */
  const [opened, setOpened] = useState<Record<string, boolean>>({});

  function toggleSection(id: string) {
    setCollapsed((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  function toggleCard(key: string) {
    setOpened((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [w, f, b, p] = await Promise.all([
          fetchWebHealth(),
          fetchFsHealth(),
          fetchBashHealth(),
          fetchPwshHealth(),
        ]);
        if (!alive) return;
        setWeb(w);
        setFs(f);
        setBash(b);
        setPwsh(p);
      } finally {
        if (alive) setProbing(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  function statusOf(entry: BuiltinCatalogEntry): Status {
    const key = builtinRuntimeKey(entry.id);
    if (key === 'none') return { label: '规划中', tone: 'plan' };
    if (key === 'ready') return { label: '已就绪', tone: 'ready' };
    if (probing) return { label: '探测中…', tone: 'plan' };
    if (key === 'web')
      return web?.ok ? { label: '已就绪', tone: 'ready' } : { label: '需本地服务', tone: 'warn' };
    if (key === 'fs')
      return fs?.ok ? { label: '已就绪', tone: 'ready' } : { label: '需本地服务', tone: 'warn' };
    if (key === 'bash')
      return bash?.ok ? { label: '已就绪', tone: 'ready' } : { label: '需本地服务', tone: 'warn' };
    if (key === 'pwsh') {
      if (pwsh?.ok && pwsh.available) return { label: '已就绪', tone: 'ready' };
      if (pwsh?.ok) return { label: '未装 PowerShell', tone: 'warn' };
      return { label: '需本地服务', tone: 'warn' };
    }
    return { label: '规划中', tone: 'plan' };
  }

  const keyword = query.trim().toLowerCase();
  const match = (e: BuiltinCatalogEntry) =>
    !keyword ||
    e.id.toLowerCase().includes(keyword) ||
    displayRole(e.roleZh).toLowerCase().includes(keyword);

  const session = SESSION_PLUGIN_CATALOG.filter(match);
  const global = GLOBAL_PLUGIN_CATALOG.filter(match);

  const groups = [
    {
      id: 'session',
      title: '会话插件',
      hint: '每个会话各自加载，随会话结束释放',
      items: session,
      total: SESSION_PLUGIN_CATALOG.length,
    },
    {
      id: 'global',
      title: '全局插件',
      hint: '由系统与所有会话共享，常驻运行',
      items: global,
      total: GLOBAL_PLUGIN_CATALOG.length,
    },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-6 pt-5 pb-3">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h3 className="text-[15px] font-semibold text-stone-900">内置插件</h3>
            <p className="mt-1 text-xs leading-5 text-stone-500">
              由平台按会话或全局提供，默认常开，不需要开关；状态取决于本机服务是否就绪。
            </p>
          </div>
          <label className="relative block w-44 shrink-0">
            <svg
              aria-hidden="true"
              className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-stone-400"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索插件名 / 作用"
              className="h-8 w-full rounded-lg border border-stone-200 bg-white pl-8 pr-2.5 text-xs text-stone-800 outline-none transition-colors placeholder:text-stone-400 focus:border-[#4176e6]"
            />
          </label>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
        <div className="space-y-3">
          {groups.map((g) => {
            const open = !collapsed[g.id];
            return (
              <section
                key={g.id}
                className="overflow-hidden rounded-xl border border-stone-200 bg-white"
              >
                <button
                  type="button"
                  onClick={() => toggleSection(g.id)}
                  aria-expanded={open}
                  className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left transition-colors hover:bg-stone-50/70"
                >
                  <Chevron open={open} />
                  <h4 className="text-[13px] font-medium text-stone-700">{g.title}</h4>
                  <span className="text-[11px] tabular-nums text-stone-400">
                    {keyword ? `${g.items.length}/${g.total}` : g.total}
                  </span>
                  <span className="ml-auto truncate text-[11px] text-stone-400">{g.hint}</span>
                </button>

                {open ? (
                  g.items.length ? (
                    <div className="grid grid-cols-2 items-start gap-2 border-t border-stone-100 p-2.5">
                      {g.items.map((e) => {
                        const st = statusOf(e);
                        const cardKey = `${g.id}:${e.id}`;
                        const expanded = Boolean(opened[cardKey]);
                        return (
                          <div
                            key={cardKey}
                            role="button"
                            tabIndex={0}
                            aria-expanded={expanded}
                            onClick={() => toggleCard(cardKey)}
                            onKeyDown={(ev) => {
                              if (ev.key === 'Enter' || ev.key === ' ') {
                                ev.preventDefault();
                                toggleCard(cardKey);
                              }
                            }}
                            className={`flex cursor-pointer flex-col rounded-lg border p-2.5 text-left transition-colors ${
                              expanded
                                ? 'border-[#4176e6]/40 bg-[#f6f9ff]'
                                : 'border-stone-200 bg-white hover:border-stone-300 hover:bg-stone-50/60'
                            }`}
                          >
                            <div className="flex items-start gap-2">
                              <span className="mt-1.5">
                                <Dot tone={st.tone} />
                              </span>
                              <div className="min-w-0 flex-1">
                                <p className="truncate font-mono text-[12.5px] text-stone-800">
                                  {e.id}
                                </p>
                                <p
                                  className={`mt-0.5 text-[11.5px] leading-5 text-stone-500 ${
                                    expanded ? '' : 'line-clamp-2'
                                  }`}
                                >
                                  {displayRole(e.roleZh)}
                                </p>
                              </div>
                              <div className="flex shrink-0 flex-col items-end gap-1.5">
                                <StatusPill status={st} />
                                <Chevron open={expanded} />
                              </div>
                            </div>
                            {expanded ? (
                              <dl className="mt-2 grid w-full grid-cols-[auto_1fr] gap-x-2 gap-y-1 border-t border-stone-200/70 pt-2 text-[11px]">
                                <dt className="shrink-0 text-stone-400">分类</dt>
                                <dd className="truncate text-stone-600">{e.category}</dd>
                                <dt className="shrink-0 text-stone-400">npm 包</dt>
                                <dd className="truncate font-mono text-stone-600">
                                  {e.packageName || '—'}
                                </dd>
                              </dl>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="border-t border-stone-100 px-3.5 py-4 text-center text-xs text-stone-400">
                      没有匹配的内置插件
                    </p>
                  )
                ) : null}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

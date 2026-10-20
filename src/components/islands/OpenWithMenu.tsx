/**
 * 打开方式：分裂按钮（左段直接执行默认应用，右段展开菜单）+ 应用列表。
 *
 * 应用来自后端探测（只列本机真装了的），图标是 qlmanage 从 .app 抽的缩略图；
 * 图标加载失败时退化成首字母色块，不出现裂图。
 */
import { Menu, MenuButton, MenuItem, MenuItems } from '@headlessui/react';
import { useEffect, useState } from 'react';

import { fetchOpenApps, type UiOpenApp } from '../../lib/ui-auto-agent';
import { readViewText, writeViewText } from '../../lib/view-prefs';

const OPEN_APP_PREF = 'ui-auto.openapp';

const KIND_FALLBACK: Record<string, string> = {
  finder: '#3b82f6',
  // 深色下面板是 #1a1d26，原来近黑的 #111827 等于消失了，这里提到 slate-700
  terminal: '#334155',
  editor: '#64748b',
};

function AppIcon({ app, size = 16 }: { app: UiOpenApp; size?: number }) {
  const [failed, setFailed] = useState(false);
  if (!app.iconUrl || failed) {
    if (app.kind === 'finder') {
      return (
        <svg
          className="shrink-0 text-[#3b82f6]"
          width={size}
          height={size}
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M2 5.5A1.5 1.5 0 013.5 4h4l1.5 2h7.5A1.5 1.5 0 0118 7.5v7A1.5 1.5 0 0116.5 16h-13A1.5 1.5 0 012 14.5v-9z" />
        </svg>
      );
    }
    if (app.kind === 'terminal') {
      return (
        <svg
          className="shrink-0 text-stone-700"
          width={size}
          height={size}
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          aria-hidden="true"
        >
          <rect x="2.5" y="3.5" width="15" height="13" rx="2" />
          <path d="M6 8l2.5 2L6 12M10.5 12.5h3.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    }
    return (
      <span
        className="flex shrink-0 items-center justify-center rounded-[4px] text-[9px] font-semibold text-white"
        style={{
          width: size,
          height: size,
          backgroundColor: KIND_FALLBACK[app.kind] ?? '#94a3b8',
        }}
        aria-hidden="true"
      >
        {app.label.slice(0, 1).toUpperCase()}
      </span>
    );
  }
  return (
    <img
      src={app.iconUrl}
      alt=""
      width={size}
      height={size}
      className="shrink-0 rounded-[4px] object-contain"
      onError={() => setFailed(true)}
    />
  );
}

export default function OpenWithMenu({
  onOpen,
  disabled = false,
  compact = false,
}: {
  /** 用指定应用打开「当前目标」；不传 app 表示用默认 */
  onOpen: (app: UiOpenApp | null) => void;
  disabled?: boolean;
  /** 只在面板头部用，尺寸略小 */
  compact?: boolean;
}) {
  const [apps, setApps] = useState<UiOpenApp[]>([]);
  const [defaultId, setDefaultId] = useState('');
  const [chosen, setChosen] = useState(() => readViewText(OPEN_APP_PREF));
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchOpenApps()
      .then((result) => {
        if (!alive) return;
        setApps(result.apps);
        setDefaultId(result.defaultId);
      })
      .catch(() => undefined)
      .finally(() => {
        if (alive) setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  const active = apps.find((app) => app.id === chosen) ?? apps.find((app) => app.id === defaultId);
  const usable = apps.length > 0;
  const blocked = disabled || !usable;

  const pick = (app: UiOpenApp | null) => {
    if (!app) return;
    setChosen(app.id);
    writeViewText(OPEN_APP_PREF, app.id);
    onOpen(app);
  };

  const box = compact ? 'h-7' : 'h-8';

  return (
    <div
      className={`inline-flex shrink-0 overflow-hidden rounded-lg border border-stone-200 bg-white ${box} ${
        blocked ? 'opacity-50' : ''
      }`}
    >
      <button
        type="button"
        className="flex items-center px-1.5 transition-colors enabled:hover:bg-stone-50 disabled:cursor-not-allowed"
        onClick={() => {
          if (!usable) return;
          onOpen(active ?? null);
        }}
        disabled={blocked}
        aria-label={active ? `用 ${active.label} 打开` : '打开方式'}
      >
        {active ? (
          <AppIcon app={active} size={compact ? 14 : 16} />
        ) : (
          <span className="px-1 text-[11px] text-stone-400">
            {loaded ? '无可用应用' : '加载中'}
          </span>
        )}
      </button>
      <span className="my-1 w-px shrink-0 bg-stone-200" aria-hidden="true" />
      <Menu as="div" className="relative flex">
        <MenuButton
          type="button"
          className="flex w-7 items-center justify-center text-stone-400 transition-colors enabled:hover:bg-stone-50 enabled:hover:text-stone-600 disabled:cursor-not-allowed"
          disabled={blocked}
          aria-label="选择打开方式"
        >
          <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path
              fillRule="evenodd"
              d="M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
              clipRule="evenodd"
            />
          </svg>
        </MenuButton>
        <MenuItems
          anchor={{ to: 'bottom end', gap: 4, padding: 12 }}
          transition
          className="tw-select-menu tw-menu-anim z-80 w-max min-w-[180px] space-y-0.5 rounded-lg p-1 pb-2 shadow-lg ring-1 ring-stone-200 focus:outline-none"
        >
          {apps.map((app) => {
            const selected = app.id === (chosen || defaultId);
            return (
              <MenuItem key={app.id}>
                <button
                  type="button"
                  className={`flex w-full select-none items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm ${
                    selected
                      ? 'bg-(--tw-accent-soft) font-medium text-(--tw-accent)'
                      : 'text-stone-700 data-[focus]:bg-stone-50'
                  }`}
                  onClick={() => pick(app)}
                >
                  <AppIcon app={app} size={18} />
                  <span className="truncate">{app.label}</span>
                  {app.id === defaultId ? (
                    <span className="ml-auto shrink-0 pl-3 text-[11px] text-stone-400">默认</span>
                  ) : null}
                </button>
              </MenuItem>
            );
          })}
          {apps.length ? null : (
            <div className="px-2.5 py-2 text-xs text-stone-400">没有探测到可用应用</div>
          )}
        </MenuItems>
      </Menu>
    </div>
  );
}

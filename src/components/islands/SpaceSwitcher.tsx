/**
 * 侧栏顶部的数据空间切换器。
 *
 * - 显示当前空间名，点击展开列表即可热切换（切换成功后整页重载，
 *   因为各页面在挂载时读到的数据仍来自旧空间）。
 * - 底部入口打开数据空间管理面板（增删改 / 复制 / 导入导出）。
 * - 静态部署（无本地服务）时渲染一个不可点击的「工作区不可用」占位，
 *   避免侧栏顶部留一块空白，也让「为什么点不了」有明确交代。
 *
 * 首帧用 sessionStorage 缓存直接渲染：岛屿是 client:only，服务端不输出，
 * 没有缓存时刷新会先空一块再「弹」出来。缓存命中则首帧就是正确内容，
 * 骨架（layout 里那块静态占位）随之被 CSS 隐藏。
 */
import { Menu, MenuButton, MenuItem, MenuItems } from '@headlessui/react';
import { useEffect, useState } from 'react';

import { t } from '../../lib/i18n';
import { navEntryForPath } from '../../lib/nav-menu';
import { pluginEnabledWith } from '../../lib/plugins';
import {
  displaySpaceName,
  listSpaces,
  spacesAvailable,
  switchSpace,
  type SpaceList,
} from '../../lib/spaces-client';
import SpaceManagerDialog from './SpaceManagerDialog';

/** 上一次成功拿到的空间列表：仅用于首帧渲染，避免刷新时闪一下 */
const CACHE_KEY = 'tw.spaces.list.v1';

/**
 * 切换后新空间里是否还有当前页面对应的菜单。
 * 空间级插件开关存在各空间自己的配置文件里，这里在切换完成后直接问服务端，
 * 读不到就按「有」处理，别把用户拦在正常重载之外。
 */
async function routeAvailableInCurrentSpace(): Promise<boolean> {
  const entry = navEntryForPath(window.location.pathname, import.meta.env.BASE_URL);
  if (!entry?.plugin) return true;
  try {
    const res = await fetch('/__tb_config', { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return true;
    const data = (await res.json()) as { config?: { plugins?: Record<string, boolean> } };
    return pluginEnabledWith(data.config?.plugins ?? {})[entry.plugin] !== false;
  } catch {
    return true;
  }
}

function readCache(): SpaceList | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as SpaceList;
    return data && Array.isArray(data.spaces) ? data : null;
  } catch {
    return null;
  }
}

function writeCache(list: SpaceList): void {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(list));
  } catch {
    // 隐私模式下写不进去：忽略即可，下次刷新退回骨架
  }
}

/** 标记「本次部署没有本地服务」：layout 用它隐藏静态骨架 */
function markNoLocalService(on: boolean): void {
  try {
    if (on) document.documentElement.dataset.spaceService = 'none';
    else delete document.documentElement.dataset.spaceService;
  } catch {
    // ignore
  }
}

export default function SpaceSwitcher() {
  const cached = readCache();
  const [available, setAvailable] = useState(cached !== null);
  /** 探测是否已有结论：未结论前不渲染（保留骨架），避免首帧闪「工作区不可用」 */
  const [probed, setProbed] = useState(cached !== null);
  const [list, setList] = useState<SpaceList | null>(cached);
  const [managerOpen, setManagerOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    void (async () => {
      const ok = await spacesAvailable();
      if (!alive) return;
      setProbed(true);
      if (!ok) {
        // 纯静态部署：切换器退化为「工作区不可用」占位，骨架也一并撤掉
        setAvailable(false);
        markNoLocalService(true);
        return;
      }
      markNoLocalService(false);
      setAvailable(true);
      const data = await listSpaces();
      if (alive && data) {
        setList(data);
        writeCache(data);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function onSwitch(id: string) {
    if (id === list?.activeId) return;
    setSwitching(true);
    setError('');
    const out = await switchSpace(id);
    if (!out.ok) {
      setSwitching(false);
      setError(out.error || '切换失败');
      return;
    }
    // 重载前改掉列表缓存的 activeId，避免首帧仍画旧空间名 / 读旧缓存键
    if (list) {
      writeCache({
        ...list,
        activeId: id,
        spaces: list.spaces.map((s) => ({ ...s, isActive: s.id === id })),
      });
    }
    // 服务端已热切换数据根；已有空间没有当前页面对应的菜单时回工作台，
    // 否则会停在一个「插件未启用」的提示页上
    if (!(await routeAvailableInCurrentSpace())) {
      window.location.replace(`${import.meta.env.BASE_URL}workbench/`);
      return;
    }
    window.location.reload();
  }

  // 探测中：留静态骨架占位，避免先闪一下「工作区不可用」
  if (!probed) return null;

  // 静态部署（无本地服务）：不可切换，只说明当前工作区不可用
  if (!available) {
    return (
      <div className="tw-nav-space">
        <div className="tw-nav-space-btn tw-nav-space-btn--off">
          <span className="tw-nav-space-ico" aria-hidden="true">
            <SpaceGlyph />
          </span>
          <span className="tw-nav-space-text">
            <span className="tw-nav-space-cap">{t('space.offlineCap')}</span>
            <span className="tw-nav-space-name">{t('space.offline')}</span>
          </span>
        </div>
      </div>
    );
  }

  const active = list?.spaces.find((s) => s.isActive);
  const others = (list?.spaces ?? []).filter((s) => !s.isActive);

  return (
    <>
      <div className="tw-nav-space">
        <Menu as="div" className="tw-nav-space-menu">
          <MenuButton className="tw-nav-space-btn" data-hint={t('space.label')}>
            <span className="tw-nav-space-ico" aria-hidden="true">
              <SpaceGlyph />
            </span>
            <span className="tw-nav-space-text">
              <span className="tw-nav-space-cap">{t('space.current')}</span>
              <span className="tw-nav-space-name">
                {switching ? t('space.switching') : active ? displaySpaceName(active) : '—'}
              </span>
            </span>
            <svg
              className="tw-nav-space-caret"
              viewBox="0 0 24 24"
              width="13"
              height="13"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </MenuButton>

          <MenuItems
            transition
            /* 卡片与上方触发按钮的间距：0.625rem(10px) 偏空，收到 6px */
            anchor={{ to: 'bottom start', gap: '0.375rem' }}
            className="tw-nav-space-pop tw-menu-anim"
          >
            {error ? (
              <div className="tw-nav-space-err" role="alert">
                {error}
              </div>
            ) : null}

            <div className="tw-nav-space-group">{t('space.others')}</div>
            {others.length === 0 ? (
              <p className="tw-nav-space-hint">{t('space.othersEmpty')}</p>
            ) : (
              others.map((s) => (
                <MenuItem key={s.id}>
                  <button
                    type="button"
                    className="tw-nav-space-item"
                    disabled={switching}
                    onClick={() => void onSwitch(s.id)}
                  >
                    <span className="tw-nav-space-item-main">
                      <span className="tw-nav-space-item-name" data-hint={displaySpaceName(s)}>
                        {displaySpaceName(s)}
                      </span>
                    </span>
                    <svg
                      className="tw-nav-space-item-go"
                      viewBox="0 0 24 24"
                      width="14"
                      height="14"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.75"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="m9 6 6 6-6 6" />
                    </svg>
                  </button>
                </MenuItem>
              ))
            )}

            <div className="tw-nav-space-sep" />
            <MenuItem>
              <button
                type="button"
                className="tw-nav-space-item tw-nav-space-item--manage"
                onClick={() => setManagerOpen(true)}
              >
                <span className="tw-nav-space-item-ico" aria-hidden="true">
                  <svg
                    viewBox="0 0 24 24"
                    width="14"
                    height="14"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.75"
                  >
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9c.2.6.7 1 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
                  </svg>
                </span>
                <span className="tw-nav-space-item-main">
                  <span className="tw-nav-space-item-name">{t('space.manage')}</span>
                </span>
                <svg
                  className="tw-nav-space-item-go"
                  viewBox="0 0 24 24"
                  width="14"
                  height="14"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="m9 6 6 6-6 6" />
                </svg>
              </button>
            </MenuItem>
          </MenuItems>
        </Menu>
      </div>

      <SpaceManagerDialog
        open={managerOpen}
        onClose={() => setManagerOpen(false)}
        onListChanged={(data) => {
          setList(data);
          writeCache(data);
        }}
      />
    </>
  );
}

/** 空间图标（切换器与不可用占位共用） */
function SpaceGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 7.5 12 3l9 4.5-9 4.5-9-4.5Z" />
      <path d="m3 12.5 9 4.5 9-4.5" />
      <path d="m3 17 9 4.5 9-4.5" />
    </svg>
  );
}

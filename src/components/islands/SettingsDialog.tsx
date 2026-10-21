import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Listbox,
  ListboxButton,
  ListboxOption,
  ListboxOptions,
  Transition,
  TransitionChild,
} from '@headlessui/react';
import { APP_VERSION } from '../../lib/app-version';
import { t } from '../../lib/i18n';
import { fetchUpdateInfo, startUpdate, type UpdateInfo } from '../../lib/update';
import BuiltinPluginsSection from './BuiltinPluginsSection';
import { showToast } from './Toast';
import { fetchModels } from '../../lib/llm';
import { getCachedAppConfig } from '../../lib/app-config';
import ConfirmDialog from './ConfirmDialog';
import {
  OPEN_SETTINGS_EVENT,
  PROVIDER_PRESETS,
  applyGeneralPrefs,
  deleteModelProvider,
  getActiveProviderId,
  getCachedApiKey,
  hydrateAppConfig,
  isAppConfigFileMode,
  loadAccessLevel,
  loadGeneralPrefs,
  loadModelProviders,
  loadSettings,
  newProviderId,
  onAccessLevelChanged,
  onGeneralPrefsChanged,
  saveAccessLevel,
  saveGeneralPrefs,
  setActiveModelProvider,
  upsertModelProvider,
  type AccessLevel,
  type AppAppearance,
  type AppLanguage,
  type BusySendBehavior,
  type GeneralPrefs,
  type ModelProvider,
  type SettingsTab,
  type ToolStepDetail,
} from '../../lib/settings';

type ModelsStatus = 'idle' | 'loading' | 'ok' | 'fail';

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

const LANG_OPTIONS: Array<{ value: AppLanguage; label: string }> = [
  { value: 'zh-CN', label: '中文' },
  { value: 'en', label: 'English' },
];

const inputCls =
  'w-full px-3 py-2 text-sm border border-stone-300 rounded-lg bg-white ' +
  'focus:outline-none focus:ring-2 focus:ring-[#4176e6]/35 focus:border-[#4176e6] transition-colors';

const pillBtnCls =
  'inline-flex items-center gap-1.5 h-9 min-w-30 px-3 rounded-lg bg-stone-100 text-sm text-stone-700 ' +
  'hover:bg-stone-200/80 transition-colors outline-none focus:outline-none';

function ChevronDown({ className = 'w-3.5 h-3.5' }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path d="M6 8l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CheckMini({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M5 10.5l3.5 3.5L15 6.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function GearIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" />
    </svg>
  );
}

function ModelIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
    >
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
      <path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
    </svg>
  );
}

function PuzzleIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
    >
      <path d="M10 4a2 2 0 0 1 4 0v1h3a1 1 0 0 1 1 1v3h1a2 2 0 0 1 0 4h-1v3a1 1 0 0 1-1 1h-3v1a2 2 0 0 1-4 0v-1H7a1 1 0 0 1-1-1v-3H5a2 2 0 0 1 0-4h1V6a1 1 0 0 1 1-1h3V4z" />
    </svg>
  );
}

function AppearIcon({ kind }: { kind: 'sun' | 'moon' | 'monitor' }) {
  const cls = 'w-5 h-5';
  if (kind === 'sun') {
    return (
      <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
    );
  }
  if (kind === 'moon') {
    return (
      <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
        <path d="M21 14.5A8.5 8.5 0 1 1 9.5 3a7 7 0 0 0 11.5 11.5z" />
      </svg>
    );
  }
  return (
    <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </svg>
  );
}

function SettingRow({
  title,
  description,
  control,
}: {
  title: string;
  description?: string;
  control: ReactNode;
}) {
  return (
    <div className="flex items-center gap-4 py-4 border-b border-stone-100 last:border-b-0">
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-stone-800">{title}</div>
        {description ? (
          <div className="mt-0.5 text-xs text-stone-400 leading-5">{description}</div>
        ) : null}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

function PrefSelect<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
}) {
  const cur = options.find((o) => o.value === value)?.label ?? value;
  return (
    <Listbox value={value} onChange={onChange}>
      <ListboxButton className={pillBtnCls}>
        <span className="flex-1 text-left truncate">{cur}</span>
        <ChevronDown className="w-3.5 h-3.5 text-stone-400 shrink-0" />
      </ListboxButton>
      <ListboxOptions
        transition
        anchor={{ to: 'bottom end', gap: 6 }}
        className="tw-select-menu tw-menu-anim z-60 min-w-40 rounded-xl py-1 shadow-lg ring-1 ring-stone-200 focus:outline-none"
      >
        {options.map((o) => (
          <ListboxOption
            key={o.value}
            value={o.value}
            className="group cursor-pointer select-none flex items-center justify-between gap-3 px-3 py-2 text-sm text-stone-700 data-[focus]:bg-stone-50 data-[selected]:text-stone-900"
          >
            <span>{o.label}</span>
            <CheckMini className="w-4 h-4 text-[#4176e6] opacity-0 group-data-[selected]:opacity-100 shrink-0" />
          </ListboxOption>
        ))}
      </ListboxOptions>
    </Listbox>
  );
}

export default function SettingsDialog() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<SettingsTab>('general');
  const [providers, setProviders] = useState<ModelProvider[]>(
    // 首帧直接读上次缓存的提供商列表，否则刷新时侧栏会先画「未配置」再翻成模型名
    () => getCachedAppConfig().model.providers,
  );
  const [activeId, setActiveId] = useState(() => getCachedAppConfig().model.activeId);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [preset, setPreset] = useState('DeepSeek');
  const [baseURL, setBaseURL] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [modelsStatus, setModelsStatus] = useState<ModelsStatus>('idle');
  const [showKey, setShowKey] = useState(false);
  const [access, setAccess] = useState<AccessLevel>('readonly');
  const [fileMode, setFileMode] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [deleteProviderId, setDeleteProviderId] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<GeneralPrefs>({
    language: 'zh-CN',
    appearance: 'system',
    sessionFontSize: 14,
    toolStepDetail: 'standard',
    busySendBehavior: 'queue',
    subagentModel: '',
  });
  /**
   * 字号输入框的草稿值。受控 input 若在 onChange 里立刻夹取，
   * 键盘敲「18」会被逐字符夹成 12 → 128 → 22；改为本地草稿、失焦/回车再提交。
   */
  const [fontSizeDraft, setFontSizeDraft] = useState('14');
  const fetchSeq = useRef(0);

  // —— 平台版本 / 更新 ——
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateLoaded, setUpdateLoaded] = useState(false);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateError, setUpdateError] = useState('');
  const updatePollRef = useRef<number | null>(null);
  const updatePollBusyRef = useRef(false);

  const isEditing = editingId !== null;
  const lang = prefs.language;
  const activeProvider = providers.find((p) => p.id === activeId);
  const providerName = (activeProvider?.name || '').trim();

  // 更新条目：`done` 只保留一天的展示，避免很久以后再打开设置还看到「已更新到」
  const updateStatus = updateInfo?.status ?? null;
  // 更新条目：`done` 只保留一天的展示，避免很久以后再打开设置还看到「已更新到」。
  // 还要求「页面里的版本 != 服务端版本」：页面已随新服务刷新过，就不该再提示刷新，
  // 否则刷新完还是同一个「刷新页面」按钮，看起来像没生效。
  const updateDone =
    updateStatus?.phase === 'done' &&
    Boolean(updateStatus.to) &&
    updateStatus.to === updateInfo?.current &&
    APP_VERSION !== updateInfo?.current &&
    Date.now() - Date.parse(updateStatus.finishedAt || '') < 24 * 60 * 60 * 1000;
  const updateFailedText = updateStatus?.phase === 'failed' ? updateStatus.error : '';
  const updateRunning =
    updateBusy || updateStatus?.phase === 'installing' || updateStatus?.phase === 'restarting';
  const updateTarget = (updateStatus?.to || updateInfo?.latest || '').replace(/^v/, '');
  // 后端状态里的失败优先：它能解释「为什么更新没完成」；本地错误只兜底超时 / 请求被拒
  const updateProblem = updateFailedText || updateError;
  const updateCheckedAt =
    updateInfo?.checkedAt && !updateRunning
      ? new Date(updateInfo.checkedAt).toLocaleTimeString()
      : '';
  /**
   * 版本行下方的补充说明。只放「需要解释」的状态：
   * 检查中由按钮自己转圈（不在下面多一行），正常无更新也只留一句「已是最新版本」。
   */
  const updateNote = updateChecking
    ? ''
    : updateRunning
      ? updateStatus?.phase === 'restarting'
        ? t('settings.updateRestarting', undefined, lang)
        : t('settings.updateInstalling', { v: updateTarget }, lang)
      : updateProblem
        ? `${t('settings.updateFailed', undefined, lang)}：${updateProblem}`
        : updateDone
          ? t('settings.updateDone', { v: updateStatus?.to || '' }, lang)
          : updateInfo?.mode === 'dev' && updateInfo?.hasUpdate
            ? t('settings.updateDevMode', undefined, lang)
            : updateInfo?.error
              ? `${t('settings.updateUnavailable', undefined, lang)}：${updateInfo.error}`
              : updateInfo?.hasUpdate
                ? updateInfo.mode === 'npx'
                  ? t('settings.updateNpxHint', undefined, lang)
                  : ''
                : updateInfo
                  ? `${t('settings.updateLatest', undefined, lang)}${
                      updateCheckedAt
                        ? ` · ${t('settings.updateCheckedAt', { time: updateCheckedAt }, lang)}`
                        : ''
                    }`
                  : updateLoaded
                    ? t('settings.updateUnavailable', undefined, lang)
                    : '';
  const providerChipLabel = providerName ? providerName : lang === 'en' ? 'No model' : '未配置';
  const providerChipTitle = providerName
    ? activeProvider?.model?.trim()
      ? `${providerName} · ${activeProvider.model.trim()}`
      : providerName
    : lang === 'en'
      ? 'No model configured'
      : '未配置模型';

  function openSettings(nextTab: SettingsTab = 'general') {
    setTab(nextTab);
    void hydrateAppConfig().then(() => {
      syncFromCache();
      setOpen(true);
    });
  }

  function syncFromCache() {
    setFileMode(isAppConfigFileMode());
    setProviders(loadModelProviders());
    setActiveId(getActiveProviderId());
    setConfigured(Boolean(loadSettings()));
    setPrefs(loadGeneralPrefs());
    applyGeneralPrefs(loadGeneralPrefs());
    setAccess(loadAccessLevel());
    setEditingId(null);
  }

  /* ---------------------- 版本检查与一键更新 ---------------------- */

  function stopUpdatePoll() {
    if (updatePollRef.current !== null) {
      window.clearInterval(updatePollRef.current);
      updatePollRef.current = null;
    }
  }

  async function checkUpdate(refresh = true) {
    setUpdateChecking(true);
    try {
      const info = await fetchUpdateInfo(refresh);
      if (info) {
        setUpdateInfo(info);
        // 别把后端的 failed 文案盖掉：这里只清掉本地错误
        setUpdateError('');
      }
    } finally {
      setUpdateChecking(false);
      setUpdateLoaded(true);
    }
  }

  /**
   * 更新后轮询：服务会先断开再回来，请求失败期间保持「进行中」，
   * 直到读到新版本 / done / failed，或超过 180s 报超时。
   */
  function pollUpdate(from: string) {
    stopUpdatePoll();
    const deadline = Date.now() + 180_000;
    updatePollRef.current = window.setInterval(async () => {
      if (updatePollBusyRef.current) return;
      updatePollBusyRef.current = true;
      try {
        const info = await fetchUpdateInfo(true);
        if (info) {
          setUpdateInfo(info);
          const status = info.status;
          if (status?.phase === 'failed') {
            stopUpdatePoll();
            setUpdateBusy(false);
            setUpdateError(status.error || t('settings.updateFailed', undefined, lang));
            return;
          }
          if (status?.phase === 'done' || (from && info.current !== from)) {
            stopUpdatePoll();
            setUpdateBusy(false);
            return;
          }
        }
        if (Date.now() > deadline) {
          stopUpdatePoll();
          setUpdateBusy(false);
          setUpdateError(t('settings.updateTimeout', undefined, lang));
        }
      } finally {
        updatePollBusyRef.current = false;
      }
    }, 1500);
  }

  async function beginUpdate() {
    const version = updateInfo?.latest || '';
    setUpdateError('');
    setUpdateBusy(true);
    const from = updateInfo?.current || APP_VERSION;
    const out = await startUpdate(version || undefined);
    if (!out.ok) {
      setUpdateBusy(false);
      setUpdateError(out.error || t('settings.updateFailed', undefined, lang));
      return;
    }
    pollUpdate(from);
  }

  function openEditor(p: ModelProvider | null) {
    if (!p) {
      const id = newProviderId();
      setEditingId(id);
      setName('DeepSeek');
      setPreset('DeepSeek');
      setBaseURL('https://api.deepseek.com/v1');
      setApiKey('');
      setModel('');
      setModelOptions([]);
      setModelsStatus('idle');
      setShowKey(false);
      return;
    }
    setEditingId(p.id);
    setName(p.name);
    setBaseURL(p.baseURL);
    const cachedKey =
      p.apiKey?.trim() || (p.id === getActiveProviderId() ? getCachedApiKey().trim() : '') || '';
    setApiKey(cachedKey);
    setModel(p.model);
    setModelOptions(p.availableModels ?? []);
    setModelsStatus(p.availableModels?.length ? 'ok' : 'idle');
    setPreset(PROVIDER_PRESETS.find((x) => x.baseURL === p.baseURL)?.label ?? '自定义');
    setShowKey(false);
  }

  useEffect(() => {
    void hydrateAppConfig().then(() => syncFromCache());
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<{ tab?: SettingsTab }>).detail;
      setTab(detail?.tab === 'model' ? 'model' : detail?.tab === 'builtin' ? 'builtin' : 'general');
      void hydrateAppConfig().then(() => {
        syncFromCache();
        setOpen(true);
      });
    };
    window.addEventListener(OPEN_SETTINGS_EVENT, onOpen);
    const offPrefs = onGeneralPrefsChanged((p) => setPrefs(p));
    // 设置页的「权限」是新会话默认值；外部（另一标签页 / 会话内菜单）改了也要跟上，
    // 否则弹窗开着时会一直显示旧值。
    const offAccess = onAccessLevelChanged((level) => setAccess(level));
    return () => {
      window.removeEventListener(OPEN_SETTINGS_EVENT, onOpen);
      offPrefs();
      offAccess();
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    void (async () => {
      const info = await fetchUpdateInfo(false);
      setUpdateLoaded(true);
      if (!info) return;
      setUpdateInfo(info);
      // 上次升级还没走完（例如更新中途刷新了页面）：继续按进行中展示并轮询
      const status = info.status;
      if (status?.phase === 'installing' || status?.phase === 'restarting') {
        setUpdateBusy(true);
        pollUpdate(status.from || info.current);
      }
    })();
    return stopUpdatePoll;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open || tab !== 'model' || !isEditing) return;
    const url = baseURL.trim();
    const key = apiKey.trim();
    if (!url || !key) {
      setModelsStatus((prev) => (prev === 'ok' ? 'ok' : 'idle'));
      return;
    }
    setModelsStatus('loading');
    const seq = ++fetchSeq.current;
    const timer = setTimeout(() => {
      fetchModels(url, key)
        .then((ids) => {
          if (seq !== fetchSeq.current) return;
          setModelOptions(ids);
          setModelsStatus('ok');
        })
        .catch(() => {
          if (seq !== fetchSeq.current) return;
          setModelsStatus('fail');
        });
    }, 800);
    return () => clearTimeout(timer);
  }, [open, tab, isEditing, baseURL, apiKey]);

  function applyPreset(label: string) {
    setPreset(label);
    const p = PROVIDER_PRESETS.find((x) => x.label === label);
    if (p) {
      if (p.baseURL) setBaseURL(p.baseURL);
      if (!name.trim() || PROVIDER_PRESETS.some((x) => x.label === name)) setName(p.label);
    }
    setModel('');
  }

  function patchPrefs(patch: Partial<GeneralPrefs>) {
    setPrefs(saveGeneralPrefs(patch));
  }

  // 拉取设置（含首次 hydrate）后把草稿同步到已保存值
  useEffect(() => {
    setFontSizeDraft(String(prefs.sessionFontSize));
  }, [prefs.sessionFontSize]);

  /** 提交字号草稿：空 / 非法则回退，越界由 saveGeneralPrefs 夹取后再回填 */
  function commitFontSize() {
    const n = Number(fontSizeDraft);
    if (!fontSizeDraft.trim() || !Number.isFinite(n)) {
      setFontSizeDraft(String(prefs.sessionFontSize));
      return;
    }
    const next = saveGeneralPrefs({ sessionFontSize: Math.round(n) });
    setPrefs(next);
    setFontSizeDraft(String(next.sessionFontSize));
  }

  const canSave = Boolean(name.trim() && baseURL.trim() && apiKey.trim() && model.trim());
  const hasModelOptions = modelOptions.length > 0;

  function onSaveProvider() {
    if (!canSave || !editingId) return;
    const isNew = !providers.some((p) => p.id === editingId);
    const next = upsertModelProvider(
      {
        id: editingId,
        name: name.trim(),
        baseURL: baseURL.trim(),
        apiKey: apiKey.trim(),
        model: model.trim(),
        availableModels: hasModelOptions ? modelOptions : undefined,
      },
      { activate: true },
    );
    setProviders(next);
    setActiveId(editingId);
    setEditingId(null);
    setConfigured(Boolean(loadSettings()));
    showToast(isNew ? '已新增模型服务' : '已保存模型服务', 'success');
  }

  function requestDeleteProvider(id: string) {
    setDeleteProviderId(id);
  }

  function confirmDeleteProvider() {
    const id = deleteProviderId;
    if (!id) return;
    const label = providers.find((p) => p.id === id)?.name ?? '该服务';
    setDeleteProviderId(null);
    const next = deleteModelProvider(id);
    setProviders(next);
    setActiveId(getActiveProviderId());
    if (editingId === id) setEditingId(null);
    setConfigured(Boolean(loadSettings()));
    showToast(`已删除模型服务「${label}」`, 'success');
  }

  function onActivate(id: string) {
    setActiveModelProvider(id);
    setActiveId(id);
    setConfigured(Boolean(loadSettings()));
  }

  const accessOptions: Array<{ value: AccessLevel; label: string }> = [
    { value: 'readonly', label: t('settings.access.readonly', undefined, lang) },
    { value: 'readwrite', label: t('settings.access.readwrite', undefined, lang) },
    { value: 'full', label: t('settings.access.full', undefined, lang) },
  ];

  const stepOptions: Array<{ value: ToolStepDetail; label: string }> = [
    { value: 'concise', label: t('settings.step.concise', undefined, lang) },
    { value: 'standard', label: t('settings.step.standard', undefined, lang) },
    { value: 'detailed', label: t('settings.step.detailed', undefined, lang) },
    { value: 'full', label: t('settings.step.full', undefined, lang) },
  ];

  const busySendOptions: Array<{ value: BusySendBehavior; label: string }> = [
    { value: 'queue', label: t('settings.busySend.queue', undefined, lang) },
    { value: 'interrupt', label: t('settings.busySend.interrupt', undefined, lang) },
  ];

  const appearanceOptions: Array<{
    value: AppAppearance;
    label: string;
    icon: 'sun' | 'moon' | 'monitor';
  }> = [
    { value: 'light', label: t('settings.appear.light', undefined, lang), icon: 'sun' },
    { value: 'dark', label: t('settings.appear.dark', undefined, lang), icon: 'moon' },
    { value: 'system', label: t('settings.appear.system', undefined, lang), icon: 'monitor' },
  ];

  const nav = [
    { id: 'general' as const, label: t('settings.general', undefined, lang), icon: <GearIcon /> },
    { id: 'model' as const, label: t('settings.model', undefined, lang), icon: <ModelIcon /> },
    { id: 'builtin' as const, label: t('settings.builtin', undefined, lang), icon: <PuzzleIcon /> },
  ];

  const headerTitle =
    tab === 'general' || tab === 'builtin'
      ? t(tab === 'general' ? 'settings.general' : 'settings.builtin', undefined, lang)
      : isEditing
        ? providers.some((p) => p.id === editingId)
          ? t('settings.editProvider', undefined, lang)
          : t('settings.addProviderTitle', undefined, lang)
        : t('settings.model', undefined, lang);

  return (
    <>
      <div className="tw-nav-foot-row">
        <button
          type="button"
          onClick={() => openSettings('general')}
          className="tw-nav-settings-btn"
          data-hint={configured ? '设置（已配置模型）' : '设置'}
        >
          <svg
            className="tw-nav-ico w-4.5 h-4.5 shrink-0"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9c.2.6.7 1 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
          </svg>
          <span data-i18n="nav.settings">{t('nav.settings', undefined, lang)}</span>
        </button>
        <button
          type="button"
          className={`tw-nav-provider-chip${providerName ? '' : ' is-empty'}`}
          data-hint={providerChipTitle}
          onClick={() => openSettings('model')}
        >
          <span className="tw-nav-provider-dot" aria-hidden="true" />
          <span className="tw-nav-provider-name">{providerChipLabel}</span>
        </button>
      </div>

      <Transition show={open}>
        <div className="fixed inset-0 z-110 flex items-center justify-center p-4">
          <TransitionChild>
            <div
              className="tw-dialog-backdrop-anim absolute inset-0 bg-stone-950/45"
              onClick={() => setOpen(false)}
              aria-hidden="true"
            />
          </TransitionChild>
          <TransitionChild>
            <div className="tw-settings-dialog tw-dialog-panel-anim relative bg-white rounded-2xl shadow-2xl w-full max-w-3xl h-[min(92vh,720px)] overflow-hidden flex flex-col">
              {/* 顶栏：标题 + 关闭，避免压住右侧控件 */}
              <div className="shrink-0 h-12 px-4 flex items-center justify-between border-b border-stone-100 bg-white">
                <h2 className="text-sm font-semibold text-stone-800 truncate pr-3">
                  {headerTitle}
                </h2>
                <button
                  type="button"
                  aria-label={t('settings.close', undefined, lang)}
                  onClick={() => setOpen(false)}
                  className="w-8 h-8 inline-flex items-center justify-center rounded-lg text-stone-400 hover:text-stone-700 hover:bg-stone-100 transition-colors"
                >
                  <svg
                    className="w-4 h-4"
                    viewBox="0 0 20 20"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.75"
                  >
                    <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" />
                  </svg>
                </button>
              </div>

              <div className="flex-1 min-h-0 flex">
                <aside className="w-38 shrink-0 border-r border-stone-100 bg-[#f4f5f7] py-3 px-2 space-y-0.5">
                  {nav.map((item) => {
                    const active = tab === item.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => {
                          setTab(item.id);
                          if (item.id === 'model') setEditingId(null);
                        }}
                        className={`w-full flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm transition-colors ${
                          active
                            ? 'bg-[#e8f0fe] text-[#4176e6] font-medium'
                            : 'text-stone-600 hover:bg-white/70 hover:text-stone-800'
                        }`}
                      >
                        <span className={active ? 'text-[#4176e6]' : 'text-stone-400'}>
                          {item.icon}
                        </span>
                        {item.label}
                      </button>
                    );
                  })}
                </aside>

                <div className="flex-1 min-w-0 flex flex-col min-h-0 bg-white">
                  {tab === 'general' ? (
                    <div className="flex-1 min-h-0 flex flex-col">
                      <div className="flex-1 overflow-y-auto px-6 py-1">
                        <SettingRow
                          title={t('settings.access', undefined, lang)}
                          description={t('settings.accessDesc', undefined, lang)}
                          control={
                            <PrefSelect
                              value={access}
                              options={accessOptions}
                              onChange={(v) => {
                                setAccess(v);
                                saveAccessLevel(v);
                              }}
                            />
                          }
                        />
                        <SettingRow
                          title={t('settings.language', undefined, lang)}
                          control={
                            <PrefSelect
                              value={prefs.language}
                              options={LANG_OPTIONS}
                              onChange={(v) => patchPrefs({ language: v })}
                            />
                          }
                        />
                        <div className="py-4 border-b border-stone-100">
                          <div className="text-sm font-medium text-stone-800 mb-3">
                            {t('settings.appearance', undefined, lang)}
                          </div>
                          <div className="grid grid-cols-3 gap-2.5">
                            {appearanceOptions.map((o) => {
                              const active = prefs.appearance === o.value;
                              return (
                                <button
                                  key={o.value}
                                  type="button"
                                  onClick={() => patchPrefs({ appearance: o.value })}
                                  className={`flex flex-col items-center justify-center gap-2 h-19 rounded-xl border transition-colors ${
                                    active
                                      ? 'border-[#4176e6] bg-[#edf3fe] text-[#4176e6] ring-1 ring-[#4176e6]/30'
                                      : 'border-stone-200 text-stone-500 hover:border-stone-300 hover:bg-stone-50'
                                  }`}
                                >
                                  <AppearIcon kind={o.icon} />
                                  <span className="text-xs font-medium">{o.label}</span>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                        <SettingRow
                          title={t('settings.fontSize', undefined, lang)}
                          description={t('settings.fontSizeDesc', undefined, lang)}
                          control={
                            <div className="inline-flex items-center gap-1.5">
                              <input
                                type="number"
                                min={12}
                                max={22}
                                value={fontSizeDraft}
                                onChange={(e) => setFontSizeDraft(e.target.value)}
                                onBlur={commitFontSize}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') e.currentTarget.blur();
                                }}
                                className="w-14 h-9 px-2 text-sm text-center rounded-lg bg-stone-100 border-0 outline-none focus:ring-2 focus:ring-[#4176e6]/30"
                              />
                              <span className="text-sm text-stone-400">px</span>
                            </div>
                          }
                        />
                        <SettingRow
                          title={t('settings.toolSteps', undefined, lang)}
                          description={t('settings.toolStepsDesc', undefined, lang)}
                          control={
                            <PrefSelect
                              value={prefs.toolStepDetail}
                              options={stepOptions}
                              onChange={(v) => patchPrefs({ toolStepDetail: v })}
                            />
                          }
                        />
                        <SettingRow
                          title={t('settings.busySend', undefined, lang)}
                          description={t('settings.busySendDesc', undefined, lang)}
                          control={
                            <PrefSelect
                              value={prefs.busySendBehavior}
                              options={busySendOptions}
                              onChange={(v) => patchPrefs({ busySendBehavior: v })}
                            />
                          }
                        />
                        <SettingRow
                          title={t('settings.subagentModel', undefined, lang)}
                          description={t('settings.subagentModelDesc', undefined, lang)}
                          control={
                            <PrefSelect
                              value={prefs.subagentModel?.trim() ? prefs.subagentModel : 'inherit'}
                              options={[
                                {
                                  value: 'inherit',
                                  label: t('settings.subagentModel.inherit', undefined, lang),
                                },
                                ...Array.from(
                                  new Set([
                                    ...(activeProvider?.availableModels ?? []),
                                    ...(activeProvider?.model ? [activeProvider.model] : []),
                                  ]),
                                )
                                  .filter(Boolean)
                                  .map((m) => ({ value: m, label: m })),
                              ]}
                              onChange={(v) =>
                                patchPrefs({ subagentModel: v === 'inherit' ? '' : v })
                              }
                            />
                          }
                        />
                      </div>
                      <div className="shrink-0 px-6 py-3 border-t border-stone-100">
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0 flex items-center gap-2">
                            <span className="text-sm text-stone-700 whitespace-nowrap">
                              {t('settings.platformVersion', undefined, lang)}
                            </span>
                            <span className="text-sm tabular-nums text-stone-500">
                              v{APP_VERSION}
                            </span>
                            {/* 有新版时把「新版本号」放在版本行里，不额外占一行 */}
                            {updateInfo?.hasUpdate && !updateRunning && !updateDone ? (
                              <span className="inline-flex items-center h-[18px] px-1.5 rounded-full bg-[#edf3fe] text-[11px] font-medium text-[#4176e6] tabular-nums whitespace-nowrap">
                                {`${t('settings.updateAvailable', undefined, lang)} v${(
                                  updateInfo.latest || ''
                                ).replace(/^v/, '')}`}
                              </span>
                            ) : null}
                          </div>
                          <div className="shrink-0 flex items-center gap-2">
                            {updateRunning ? (
                              <span className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-xs text-stone-500 bg-stone-100 whitespace-nowrap">
                                <span className="w-3 h-3 rounded-full border-2 border-stone-300 border-t-[#4176e6] animate-spin" />
                                {t('settings.updateWorking', undefined, lang)}
                              </span>
                            ) : updateDone ? (
                              <button
                                type="button"
                                onClick={() => window.location.reload()}
                                className="h-8 px-3 rounded-lg text-xs font-medium text-[#4176e6] bg-[#edf3fe] hover:bg-[#e2ecfd] whitespace-nowrap"
                              >
                                {t('settings.updateReload', undefined, lang)}
                              </button>
                            ) : (
                              <>
                                <button
                                  type="button"
                                  disabled={updateChecking}
                                  onClick={() => void checkUpdate(true)}
                                  className="inline-flex items-center justify-center min-w-[76px] h-8 px-3 rounded-lg text-xs font-medium text-stone-600 bg-stone-100 hover:bg-stone-200 disabled:opacity-70 disabled:cursor-default whitespace-nowrap"
                                >
                                  {updateChecking ? (
                                    <>
                                      {t('settings.updateChecking', undefined, lang)}
                                      <span className="tw-dots" aria-hidden="true">
                                        <i />
                                        <i />
                                        <i />
                                      </span>
                                    </>
                                  ) : (
                                    t('settings.updateCheck', undefined, lang)
                                  )}
                                </button>
                                {updateInfo?.hasUpdate ? (
                                  <button
                                    type="button"
                                    disabled={updateInfo.mode === 'dev'}
                                    onClick={() => void beginUpdate()}
                                    className="h-8 px-3 rounded-lg text-xs font-semibold text-white bg-[#4176e6] hover:bg-[#3566d6] disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                                  >
                                    {t('settings.updateNow', undefined, lang)}
                                  </button>
                                ) : null}
                              </>
                            )}
                          </div>
                        </div>
                        {updateNote ? (
                          <div
                            className={`mt-1 text-[11px] leading-relaxed ${
                              updateProblem ? 'text-red-500' : 'text-stone-400'
                            }`}
                          >
                            {updateNote}
                          </div>
                        ) : null}
                        {updateProblem && updateInfo?.logPath ? (
                          <div className="mt-0.5 text-[11px] leading-relaxed text-stone-400 break-all">
                            {t('settings.updateLog', { path: updateInfo.logPath }, lang)}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ) : isEditing ? (
                    <>
                      <div className="shrink-0 px-5 pt-3 pb-2 flex items-center gap-2 border-b border-stone-100">
                        <button
                          type="button"
                          onClick={() => setEditingId(null)}
                          className="text-sm text-stone-500 hover:text-stone-800"
                        >
                          {t('settings.back', undefined, lang)}
                        </button>
                      </div>
                      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
                        <div>
                          <label className="block text-xs font-medium text-stone-500 mb-1.5">
                            {t('settings.displayName', undefined, lang)}
                          </label>
                          <input
                            type="text"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="DeepSeek"
                            className={inputCls}
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-stone-500 mb-1.5">
                            {t('settings.preset', undefined, lang)}
                          </label>
                          <div className="grid grid-cols-2 gap-2">
                            {PROVIDER_PRESETS.map((p) => {
                              const active = preset === p.label;
                              return (
                                <button
                                  key={p.label}
                                  type="button"
                                  onClick={() => applyPreset(p.label)}
                                  className={`text-left px-3 py-2 rounded-lg border transition-colors ${
                                    active
                                      ? 'border-[#4176e6] bg-[#edf3fe] ring-1 ring-[#4176e6]/30'
                                      : 'border-stone-200 hover:border-stone-300 hover:bg-stone-50'
                                  }`}
                                >
                                  <div
                                    className={`text-sm ${
                                      active ? 'text-[#3565c7] font-medium' : 'text-stone-700'
                                    }`}
                                  >
                                    {p.label}
                                  </div>
                                  <div className="text-[11px] text-stone-400 truncate">
                                    {p.baseURL ? hostOf(p.baseURL) : 'OpenAI compatible'}
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-stone-500 mb-1.5">
                            {t('settings.baseUrl', undefined, lang)}
                          </label>
                          <input
                            type="text"
                            value={baseURL}
                            onChange={(e) => setBaseURL(e.target.value)}
                            placeholder="https://api.deepseek.com/v1"
                            className={inputCls}
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-stone-500 mb-1.5">
                            {t('settings.apiKey', undefined, lang)}
                          </label>
                          <div className="relative">
                            <input
                              type={showKey ? 'text' : 'password'}
                              value={apiKey}
                              onChange={(e) => setApiKey(e.target.value)}
                              placeholder="sk-..."
                              className={`${inputCls} pr-14`}
                            />
                            <button
                              type="button"
                              onClick={() => setShowKey((v) => !v)}
                              className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-stone-400 hover:text-stone-600 px-1.5 py-1"
                            >
                              {showKey
                                ? lang === 'en'
                                  ? 'Hide'
                                  : '隐藏'
                                : lang === 'en'
                                  ? 'Show'
                                  : '显示'}
                            </button>
                          </div>
                          {fileMode ? (
                            <p className="mt-1.5 text-[11px] text-stone-400 leading-5">
                              {t('settings.keyHint', undefined, lang)}
                            </p>
                          ) : null}
                        </div>
                        <div>
                          <div className="flex items-center justify-between mb-1.5">
                            <label className="text-xs font-medium text-stone-500">
                              {t('settings.modelField', undefined, lang)}
                            </label>
                            {modelsStatus === 'loading' && (
                              <span className="text-[11px] text-stone-400">
                                {t('settings.recognizing', undefined, lang)}
                              </span>
                            )}
                            {hasModelOptions && modelsStatus === 'ok' && (
                              <span className="text-[11px] text-emerald-600">
                                {t('settings.recognized', { n: modelOptions.length }, lang)}
                              </span>
                            )}
                            {modelsStatus === 'fail' && !hasModelOptions && (
                              <span className="text-[11px] text-amber-600">
                                {t('settings.recognizeFail', undefined, lang)}
                              </span>
                            )}
                            {modelsStatus === 'fail' && hasModelOptions && (
                              <span className="text-[11px] text-amber-600">
                                {t('settings.recognizeKeep', undefined, lang)}
                              </span>
                            )}
                          </div>
                          {hasModelOptions ? (
                            <Listbox value={model} onChange={setModel}>
                              <ListboxButton
                                className={`${inputCls} flex items-center justify-between text-left hover:border-stone-400 cursor-pointer`}
                              >
                                <span className="truncate text-stone-800">
                                  {model || (lang === 'en' ? 'Select a model' : '请选择模型')}
                                </span>
                                <ChevronDown className="w-4 h-4 shrink-0 ml-2 text-stone-400" />
                              </ListboxButton>
                              <ListboxOptions
                                transition
                                anchor={{ to: 'bottom start', gap: 6 }}
                                className="tw-select-menu tw-menu-anim z-60 w-(--button-width) max-h-60 overflow-auto rounded-lg py-1 shadow-lg ring-1 ring-stone-200 focus:outline-none"
                              >
                                {modelOptions.map((m) => (
                                  <ListboxOption
                                    key={m}
                                    value={m}
                                    className="group cursor-pointer select-none flex items-center justify-between px-3 py-2 text-sm text-stone-700 data-[focus]:bg-[#edf3fe] data-[selected]:text-[#3565c7] data-[selected]:font-medium"
                                  >
                                    <span className="truncate">{m}</span>
                                    <CheckMini className="w-4 h-4 text-[#4176e6] opacity-0 group-data-[selected]:opacity-100 shrink-0 ml-2" />
                                  </ListboxOption>
                                ))}
                              </ListboxOptions>
                            </Listbox>
                          ) : (
                            <input
                              type="text"
                              value={model}
                              onChange={(e) => setModel(e.target.value)}
                              placeholder={t('settings.modelPlaceholder', undefined, lang)}
                              className={inputCls}
                            />
                          )}
                        </div>
                      </div>
                      <div className="shrink-0 px-5 py-3.5 bg-stone-50 border-t border-stone-100 flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setEditingId(null)}
                          className="px-3.5 py-1.5 text-sm text-stone-600 hover:bg-stone-200/60 rounded-lg"
                        >
                          {t('settings.cancel', undefined, lang)}
                        </button>
                        <button
                          type="button"
                          onClick={onSaveProvider}
                          disabled={!canSave}
                          className="px-3.5 py-1.5 text-sm font-medium text-white bg-[#4176e6] hover:bg-[#3565c7] rounded-lg disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          {t('settings.save', undefined, lang)}
                        </button>
                      </div>
                    </>
                  ) : tab === 'builtin' ? (
                    <BuiltinPluginsSection />
                  ) : (
                    <div className="flex-1 overflow-y-auto px-6 py-5 bg-[#f4f5f7]">
                      <p className="text-sm text-stone-500">
                        {t('settings.modelIntro', undefined, lang)}
                      </p>
                      <div className="mt-5 space-y-2.5">
                        {providers.map((p) => {
                          const ready = Boolean(
                            p.apiKey?.trim() && p.baseURL.trim() && p.model.trim(),
                          );
                          const isActive = p.id === activeId;
                          return (
                            <div
                              key={p.id}
                              className="flex items-center gap-3 rounded-xl border border-stone-200/90 bg-white px-4 py-3.5 shadow-[0_1px_0_rgba(15,23,42,0.02)]"
                            >
                              <button
                                type="button"
                                data-hint={
                                  isActive
                                    ? lang === 'en'
                                      ? 'Active'
                                      : '当前使用'
                                    : lang === 'en'
                                      ? 'Set active'
                                      : '设为当前'
                                }
                                onClick={() => onActivate(p.id)}
                                className="flex-1 min-w-0 flex items-center gap-2 text-left"
                              >
                                <span className="text-sm font-medium text-stone-800 truncate">
                                  {p.name}
                                </span>
                                {ready ? (
                                  <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-emerald-500" />
                                ) : null}
                              </button>
                              <div className="flex items-center gap-1.5 shrink-0">
                                <button
                                  type="button"
                                  onClick={() => openEditor(p)}
                                  className="h-8 px-3 text-sm text-stone-700 rounded-lg border border-stone-200 bg-white hover:bg-stone-50"
                                >
                                  {t('settings.edit', undefined, lang)}
                                </button>
                                {providers.length > 1 ? (
                                  <button
                                    type="button"
                                    onClick={() => requestDeleteProvider(p.id)}
                                    className="h-8 px-3 text-sm text-red-600 rounded-lg hover:bg-red-50"
                                  >
                                    {t('settings.delete', undefined, lang)}
                                  </button>
                                ) : null}
                              </div>
                            </div>
                          );
                        })}
                        <button
                          type="button"
                          onClick={() => openEditor(null)}
                          className="w-full h-12 rounded-xl border border-dashed border-stone-300 bg-white/60 text-sm text-stone-600 hover:border-[#4176e6] hover:text-[#4176e6] hover:bg-[#edf3fe]/50 transition-colors"
                        >
                          {t('settings.addProvider', undefined, lang)}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </TransitionChild>
        </div>
      </Transition>
      <ConfirmDialog
        open={deleteProviderId != null}
        title={t('settings.delete', undefined, lang)}
        message={t('settings.deleteConfirm', undefined, lang)}
        confirmLabel={t('settings.delete', undefined, lang)}
        cancelLabel={lang === 'en' ? 'Cancel' : '取消'}
        danger
        onClose={() => setDeleteProviderId(null)}
        onConfirm={confirmDeleteProvider}
      />
    </>
  );
}

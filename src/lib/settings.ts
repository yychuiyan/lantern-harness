/**
 * 模型 / 通用 / 权限设置。
 * 模型全局落盘 `~/.config/lantern-harness/models.json`；其余按空间写 `.lantern/local/app.config.json`。
 * 静态站回退 localStorage（模型键不跟空间走）。
 */
import {
  flushAppConfig,
  getCachedApiKey,
  getCachedAppConfig,
  hydrateAppConfig,
  isAppConfigFileMode,
  listModelProviders,
  newProviderId,
  setRuntimeApiKey,
  settingsFromCache,
  updateAppConfig,
} from './app-config';

/** 思考强度（DeepSeek reasoning_effort；缺省与 API 默认一致为 high） */
export type ReasoningEffort = 'low' | 'high' | 'max';

export interface LLMSettings {
  baseURL: string;
  apiKey: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
  availableModels?: string[];
}

/** 模型提供商（设置页列表一项） */
export interface ModelProvider {
  id: string;
  name: string;
  baseURL: string;
  apiKey?: string;
  model: string;
  availableModels?: string[];
  /** 上下文窗口（tokens）；缺省则用内置 MODEL_CONTEXT_WINDOW 表 */
  contextWindow?: number;
  /** 是否支持工具调用；缺省 true */
  supportsTools?: boolean;
  /** 是否支持视觉 / 图片；缺省 false */
  supportsVision?: boolean;
}

export interface ModelCaps {
  contextWindow?: number;
  supportsTools: boolean;
  supportsVision: boolean;
}

/** 当前激活提供商的能力声明（缺省安全默认） */
export function getActiveModelCaps(): ModelCaps {
  const cfg = getCachedAppConfig();
  const p = cfg.model.providers.find((x) => x.id === cfg.model.activeId);
  return {
    contextWindow:
      typeof p?.contextWindow === 'number' && p.contextWindow > 0
        ? Math.floor(p.contextWindow)
        : undefined,
    supportsTools: p?.supportsTools !== false,
    supportsVision: p?.supportsVision === true,
  };
}

export interface ProviderPreset {
  label: string;
  baseURL: string;
  model: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { label: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', model: '' },
  {
    label: '通义千问',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
  },
  { label: 'OpenAI', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { label: '自定义', baseURL: '', model: '' },
];

const CHANGED_EVENT = 'tw-settings-changed';
export const OPEN_SETTINGS_EVENT = 'tw-open-settings';

export function loadSettings(): LLMSettings | null {
  return settingsFromCache();
}

export function loadModelProviders(): ModelProvider[] {
  return listModelProviders();
}

export function getActiveProviderId(): string {
  return getCachedAppConfig().model.activeId;
}

/** 保存当前激活提供商的连接信息（对话页切换模型等） */
export function saveSettings(s: LLMSettings): void {
  const cfg = getCachedAppConfig();
  const providers = [...cfg.model.providers];
  let activeId = cfg.model.activeId;
  const idx = providers.findIndex((p) => p.id === activeId);
  if (idx < 0) {
    const id = newProviderId();
    providers.push({
      id,
      name: '默认',
      baseURL: s.baseURL.trim(),
      apiKey: s.apiKey.trim() || undefined,
      model: s.model.trim(),
      availableModels: s.availableModels,
    });
    activeId = id;
  } else {
    providers[idx] = {
      ...providers[idx],
      baseURL: s.baseURL.trim(),
      apiKey: s.apiKey.trim() || undefined,
      model: s.model.trim(),
      availableModels: s.availableModels,
    };
  }
  setRuntimeApiKey(s.apiKey);
  updateAppConfig({
    model: {
      ...cfg.model,
      activeId,
      reasoningEffort: s.reasoningEffort ?? cfg.model.reasoningEffort,
      providers,
    },
  });
  void flushAppConfig();
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(CHANGED_EVENT));
  }
}

export function upsertModelProvider(
  provider: ModelProvider,
  opts?: { activate?: boolean },
): ModelProvider[] {
  const cfg = getCachedAppConfig();
  const list = [...cfg.model.providers];
  const i = list.findIndex((p) => p.id === provider.id);
  const next: ModelProvider = {
    ...provider,
    name: provider.name.trim() || '未命名提供商',
    baseURL: provider.baseURL.trim(),
    model: provider.model.trim(),
    apiKey: provider.apiKey?.trim() || undefined,
  };
  if (i >= 0) list[i] = next;
  else list.push(next);
  const activate = opts?.activate !== false;
  const activeId = activate ? next.id : cfg.model.activeId || next.id;
  updateAppConfig({
    model: { ...cfg.model, providers: list, activeId },
  });
  void flushAppConfig();
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(CHANGED_EVENT));
  }
  return list;
}

export function deleteModelProvider(id: string): ModelProvider[] {
  const cfg = getCachedAppConfig();
  const list = cfg.model.providers.filter((p) => p.id !== id);
  let activeId = cfg.model.activeId;
  if (activeId === id) activeId = list[0]?.id ?? '';
  updateAppConfig({
    model: { ...cfg.model, providers: list, activeId },
  });
  void flushAppConfig();
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(CHANGED_EVENT));
  }
  return list;
}

export function setActiveModelProvider(id: string): void {
  const cfg = getCachedAppConfig();
  if (!cfg.model.providers.some((p) => p.id === id)) return;
  updateAppConfig({
    model: { ...cfg.model, activeId: id },
  });
  void flushAppConfig();
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(CHANGED_EVENT));
  }
}

export function patchSettings(patch: Partial<LLMSettings>): void {
  const cur = loadSettings();
  if (!cur) return;
  saveSettings({ ...cur, ...patch });
}

export type AccessLevel = 'readonly' | 'readwrite' | 'full';

const ACCESS_CHANGED_EVENT = 'tw-access-changed';

export function loadAccessLevel(): AccessLevel {
  return getCachedAppConfig().access;
}

export function saveAccessLevel(level: AccessLevel): void {
  updateAppConfig({ access: level });
  void flushAppConfig();
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(ACCESS_CHANGED_EVENT, { detail: level }));
  }
}

export function onAccessLevelChanged(cb: (level: AccessLevel) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<AccessLevel>).detail;
    cb(detail ?? loadAccessLevel());
  };
  window.addEventListener(ACCESS_CHANGED_EVENT, handler);
  return () => window.removeEventListener(ACCESS_CHANGED_EVENT, handler);
}

export function onSettingsChanged(cb: () => void): () => void {
  window.addEventListener(CHANGED_EVENT, cb);
  return () => window.removeEventListener(CHANGED_EVENT, cb);
}

export type SettingsTab = 'general' | 'model' | 'builtin';

export function openSettings(tab: SettingsTab = 'general'): void {
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: { tab } }));
}

export type AppLanguage = 'zh-CN' | 'en';
export type AppAppearance = 'light' | 'dark' | 'system';
export type ToolStepDetail = 'concise' | 'standard' | 'detailed' | 'full';
/** 繁忙时 Enter/发送：排队发送 | 插话（中断当前再发） */
export type BusySendBehavior = 'queue' | 'interrupt';

export interface GeneralPrefs {
  language: AppLanguage;
  appearance: AppAppearance;
  sessionFontSize: number;
  toolStepDetail: ToolStepDetail;
  busySendBehavior: BusySendBehavior;
  /**
   * 子代理模型：空字符串 = 跟随主会话；否则为当前提供商下的模型 id。
   * （subagent-model-selection-settings）
   */
  subagentModel: string;
  /** 是否允许 web_fetch / 搜索结果指向 localhost / 私网（默认 false） */
  allowPrivateWebFetch: boolean;
}

const GENERAL_CHANGED = 'tw-general-prefs-changed';

export function loadGeneralPrefs(): GeneralPrefs {
  return { ...getCachedAppConfig().general };
}

export function saveGeneralPrefs(patch: Partial<GeneralPrefs>): GeneralPrefs {
  const next = { ...loadGeneralPrefs(), ...patch };
  if (next.sessionFontSize < 12) next.sessionFontSize = 12;
  if (next.sessionFontSize > 22) next.sessionFontSize = 22;
  updateAppConfig({ general: next });
  void flushAppConfig();
  applyGeneralPrefs(next);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(GENERAL_CHANGED, { detail: next }));
  }
  return next;
}

export function onGeneralPrefsChanged(cb: (p: GeneralPrefs) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = (e: Event) => {
    cb((e as CustomEvent<GeneralPrefs>).detail ?? loadGeneralPrefs());
  };
  window.addEventListener(GENERAL_CHANGED, handler);
  return () => window.removeEventListener(GENERAL_CHANGED, handler);
}

let systemThemeMql: MediaQueryList | null = null;
let systemThemeHandler: (() => void) | null = null;

function resolvedTheme(appearance: AppAppearance): 'light' | 'dark' {
  if (appearance === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return appearance;
}

export function applyGeneralPrefs(prefs: GeneralPrefs = loadGeneralPrefs()): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const theme = resolvedTheme(prefs.appearance);
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  root.lang = prefs.language === 'en' ? 'en' : 'zh-CN';

  // 只改文字字号变量，不改 html font-size（否则 rem 布局/侧栏会跟着跳）
  const px = `${prefs.sessionFontSize}px`;
  root.style.setProperty('--tw-ui-font-size', px);
  root.style.setProperty('--tw-session-font-size', px);
  root.style.fontSize = '';

  // 跟随系统时监听系统主题变化
  if (systemThemeMql && systemThemeHandler) {
    systemThemeMql.removeEventListener('change', systemThemeHandler);
    systemThemeMql = null;
    systemThemeHandler = null;
  }
  if (prefs.appearance === 'system') {
    systemThemeMql = window.matchMedia('(prefers-color-scheme: dark)');
    systemThemeHandler = () => {
      const next = resolvedTheme('system');
      root.dataset.theme = next;
      root.style.colorScheme = next;
    };
    systemThemeMql.addEventListener('change', systemThemeHandler);
  }

  try {
    // 避免循环依赖：动态导入 i18n 刷新静态 DOM
    void import('./i18n').then((m) => m.applyDomI18n(prefs.language));
  } catch {
    // ignore
  }
}

export { hydrateAppConfig, isAppConfigFileMode, getCachedApiKey, newProviderId };

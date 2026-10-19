/**
 * 应用配置客户端：
 * - 空间配置：读写 `.lantern/local/app.config.json`（权限 / 插件 / 用例类型等）
 * - 模型：全局 `~/.config/lantern-harness/models.json`，不跟空间走
 * - 静态站：空间项回退 space-scoped localStorage；模型 / Key 用未加空间前缀的键
 * - 模型：多提供商列表，activeId 为当前使用的一项
 */
import type {
  AccessLevel,
  GeneralPrefs,
  LLMSettings,
  ModelProvider,
  ReasoningEffort,
} from './settings';
import { DEFAULT_CASE_TYPES, normalizeCaseTypes, type CaseTypeDef } from './case-type-defs';
import {
  DEFAULT_KNOWLEDGE_CATEGORIES,
  normalizeKnowledgeCategories,
  type KnowledgeCategory,
} from './knowledge-category-defs';
import { DEFAULT_PROMPT_KINDS, normalizePromptKinds, type PromptKindDef } from './prompt-kind-defs';
import {
  DEFAULT_NAV_GROUPS,
  DEFAULT_NAV_ICONS,
  defaultNavOrder,
  normalizeNavGroups,
  normalizeNavIcons,
  normalizeNavOrder,
  type NavIconId,
  type NavMenuGroup,
  type NavOrderKey,
  type NavEntryId,
} from './nav-menu';
import { spaceScopedKey } from './space-scope';

export interface ModelConfigBlock {
  activeId: string;
  reasoningEffort?: ReasoningEffort;
  providers: ModelProvider[];
  /** @deprecated 旧单提供商字段，normalize 时迁入 providers */
  baseURL?: string;
  model?: string;
  apiKey?: string;
  availableModels?: string[];
}

export interface AppFileConfig {
  version: number;
  model: ModelConfigBlock;
  access: AccessLevel;
  general: GeneralPrefs;
  plugins: Record<string, boolean>;
  /** 用例类型（生成测试用例插件可增删改） */
  caseTypes: CaseTypeDef[];
  /** 提示词类型 */
  promptKinds: PromptKindDef[];
  /** 知识库分类 */
  knowledgeCategories: KnowledgeCategory[];
  /** 侧栏菜单分组（默认不预置） */
  navGroups: NavMenuGroup[];
  /** 侧栏每个菜单项用的图标 */
  navIcons: Record<NavEntryId, NavIconId>;
  /** 侧栏顶层顺序（item:id / group:id） */
  navOrder: NavOrderKey[];
}

const CONFIG_API = '/__tb_config';
const LS_CONFIG = 'tw.app.config.v1';
const LS_API_KEY = 'tw.app.apikey.v1';
const LS_MODEL = 'tw.app.model.v1';

let fileMode = false;
let ready = false;
let cache: AppFileConfig | null = null;
let apiKeyCache = '';
/** 首帧是否已经从 localStorage 抢先填过 cache（只影响首屏，不改变 ready） */
let primedFromLs = false;

const DEFAULT_GENERAL: GeneralPrefs = {
  language: 'zh-CN',
  appearance: 'system',
  sessionFontSize: 14,
  toolStepDetail: 'standard',
  busySendBehavior: 'queue',
  subagentModel: '',
};

function uid(): string {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function normalizeProvider(raw: Partial<ModelProvider> | null | undefined): ModelProvider | null {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name ?? '').trim() || '未命名提供商';
  const baseURL = String(raw.baseURL ?? '').trim();
  const model = String(raw.model ?? '').trim();
  const id = String(raw.id ?? '').trim() || uid();
  return {
    id,
    name,
    baseURL,
    model,
    apiKey: typeof raw.apiKey === 'string' && raw.apiKey.trim() ? raw.apiKey.trim() : undefined,
    availableModels: Array.isArray(raw.availableModels)
      ? raw.availableModels.filter((x): x is string => typeof x === 'string')
      : undefined,
  };
}

function migrateFlatModel(model: Record<string, unknown>): ModelProvider[] {
  const baseURL = typeof model.baseURL === 'string' ? model.baseURL.trim() : '';
  const mid = typeof model.model === 'string' ? model.model.trim() : '';
  if (!baseURL && !mid && !model.apiKey) return [];
  return [
    {
      id: uid(),
      name: '默认',
      baseURL: baseURL || 'https://api.deepseek.com/v1',
      model: mid,
      apiKey:
        typeof model.apiKey === 'string' && model.apiKey.trim() ? model.apiKey.trim() : undefined,
      availableModels: Array.isArray(model.availableModels)
        ? (model.availableModels as unknown[]).filter((x): x is string => typeof x === 'string')
        : undefined,
    },
  ];
}

function normalizeModelBlock(raw: Partial<ModelConfigBlock> | null | undefined): ModelConfigBlock {
  const effort =
    raw?.reasoningEffort === 'low' ||
    raw?.reasoningEffort === 'high' ||
    raw?.reasoningEffort === 'max'
      ? raw.reasoningEffort
      : ('high' as ReasoningEffort);

  let providers: ModelProvider[] = [];
  if (Array.isArray(raw?.providers) && raw!.providers!.length) {
    providers = raw!
      .providers!.map((p) => normalizeProvider(p))
      .filter((p): p is ModelProvider => Boolean(p));
  } else if (raw && (raw.baseURL || raw.model || raw.apiKey)) {
    providers = migrateFlatModel(raw as Record<string, unknown>);
  }

  let activeId = typeof raw?.activeId === 'string' ? raw.activeId : '';
  if (providers.length && !providers.some((p) => p.id === activeId)) {
    activeId = providers[0].id;
  }
  if (!providers.length) activeId = '';

  return { activeId, reasoningEffort: effort, providers };
}

export function emptyAppConfig(): AppFileConfig {
  return {
    version: 1,
    model: { activeId: '', reasoningEffort: 'high', providers: [] },
    access: 'readonly',
    general: { ...DEFAULT_GENERAL },
    plugins: {
      cases: false,
      caseGen: false,
      prompts: true,
      promptGen: false,
      knowledgeLib: false,
      knowledgeGen: false,
      requirements: false,
      templates: false,
      knowledge: false,
      memory: false,
      pluginDev: false,
      todos: false,
      tasks: false,
      projects: false,
      iterations: false,
      pmRequirements: false,
      bugs: false,
      reports: false,
      testStats: false,
      caseExec: false,
      dashboard: false,
    },
    caseTypes: DEFAULT_CASE_TYPES.map((x) => ({ ...x })),
    promptKinds: DEFAULT_PROMPT_KINDS.map((x) => ({ ...x })),
    knowledgeCategories: [...DEFAULT_KNOWLEDGE_CATEGORIES],
    navGroups: DEFAULT_NAV_GROUPS.map((g) => ({ ...g, items: [...g.items] })),
    navIcons: { ...DEFAULT_NAV_ICONS },
    navOrder: defaultNavOrder(DEFAULT_NAV_GROUPS),
  };
}

function normalizeConfig(raw: Partial<AppFileConfig> | null | undefined): AppFileConfig {
  const base = emptyAppConfig();
  if (!raw || typeof raw !== 'object') return base;
  const general: Partial<GeneralPrefs> =
    raw.general && typeof raw.general === 'object' ? raw.general : {};
  const plugins = { ...base.plugins, ...(raw.plugins ?? {}) };
  const navGroups = normalizeNavGroups(raw.navGroups);
  return {
    version: typeof raw.version === 'number' ? raw.version : 1,
    model: normalizeModelBlock(raw.model),
    access:
      raw.access === 'readwrite' || raw.access === 'full' || raw.access === 'readonly'
        ? raw.access
        : 'readonly',
    general: {
      language: general.language === 'en' ? 'en' : 'zh-CN',
      appearance:
        general.appearance === 'light' ||
        general.appearance === 'dark' ||
        general.appearance === 'system'
          ? general.appearance
          : 'system',
      sessionFontSize:
        typeof general.sessionFontSize === 'number' &&
        general.sessionFontSize >= 12 &&
        general.sessionFontSize <= 22
          ? Math.round(general.sessionFontSize)
          : 14,
      toolStepDetail:
        general.toolStepDetail === 'concise' ||
        general.toolStepDetail === 'standard' ||
        general.toolStepDetail === 'detailed' ||
        general.toolStepDetail === 'full'
          ? general.toolStepDetail
          : 'standard',
      busySendBehavior: general.busySendBehavior === 'interrupt' ? 'interrupt' : 'queue',
      subagentModel: typeof general.subagentModel === 'string' ? general.subagentModel.trim() : '',
    },
    plugins,
    caseTypes: normalizeCaseTypes(raw.caseTypes),
    promptKinds: normalizePromptKinds(raw.promptKinds),
    knowledgeCategories: normalizeKnowledgeCategories(raw.knowledgeCategories),
    navGroups,
    navIcons: normalizeNavIcons(raw.navIcons),
    navOrder: normalizeNavOrder(raw.navOrder, navGroups),
  };
}

function readLsModel(): ModelConfigBlock | null {
  try {
    const raw = localStorage.getItem(LS_MODEL);
    if (raw) return normalizeModelBlock(JSON.parse(raw) as Partial<ModelConfigBlock>);
  } catch {
    // ignore
  }
  try {
    const scoped = localStorage.getItem(spaceScopedKey(LS_CONFIG));
    if (scoped) {
      const cfg = JSON.parse(scoped) as Partial<AppFileConfig>;
      if (cfg?.model) return normalizeModelBlock(cfg.model);
    }
  } catch {
    // ignore
  }
  return null;
}

function writeLsModel(model: ModelConfigBlock) {
  try {
    localStorage.setItem(LS_MODEL, JSON.stringify(model));
  } catch {
    // ignore
  }
}

function readLsConfig(): AppFileConfig | null {
  try {
    const raw = localStorage.getItem(spaceScopedKey(LS_CONFIG));
    const model = readLsModel();
    if (!raw) {
      return model ? normalizeConfig({ ...emptyAppConfig(), model }) : null;
    }
    const cfg = normalizeConfig(JSON.parse(raw) as Partial<AppFileConfig>);
    if (model) cfg.model = model;
    return cfg;
  } catch {
    return null;
  }
}

function writeLsConfig(cfg: AppFileConfig) {
  try {
    const { model, ...rest } = cfg;
    localStorage.setItem(spaceScopedKey(LS_CONFIG), JSON.stringify(rest));
    writeLsModel(model);
  } catch {
    // ignore
  }
}

function readLsApiKey(): string {
  try {
    return (
      localStorage.getItem(LS_API_KEY)?.trim() ||
      localStorage.getItem(spaceScopedKey(LS_API_KEY))?.trim() ||
      ''
    );
  } catch {
    return '';
  }
}

function writeLsApiKey(key: string) {
  try {
    if (key) localStorage.setItem(LS_API_KEY, key);
    else localStorage.removeItem(LS_API_KEY);
    localStorage.removeItem(spaceScopedKey(LS_API_KEY));
  } catch {
    // ignore
  }
}

function migrateLegacyLocalStorage(): AppFileConfig | null {
  try {
    const cfg = emptyAppConfig();
    let hit = false;
    const llmRaw = localStorage.getItem('tw-llm-settings');
    if (llmRaw) {
      const p = JSON.parse(llmRaw) as Partial<LLMSettings> & { name?: string };
      cfg.model = normalizeModelBlock({
        providers: [
          {
            id: uid(),
            name: p.name || '默认',
            baseURL: p.baseURL || '',
            model: p.model || '',
            apiKey: p.apiKey,
            availableModels: p.availableModels,
          },
        ],
        reasoningEffort: p.reasoningEffort,
      });
      if (cfg.model.providers[0]) cfg.model.activeId = cfg.model.providers[0].id;
      hit = true;
    }
    const access = localStorage.getItem('tw-access-level');
    if (access === 'readonly' || access === 'readwrite' || access === 'full') {
      cfg.access = access;
      hit = true;
    }
    const gRaw = localStorage.getItem('tw.general.prefs.v1');
    if (gRaw) {
      cfg.general = normalizeConfig({ general: JSON.parse(gRaw) }).general;
      hit = true;
    }
    const pRaw = localStorage.getItem('tw.plugins.enabled.v1');
    if (pRaw) {
      const map = JSON.parse(pRaw) as Record<string, boolean>;
      cfg.plugins = { ...cfg.plugins, ...map };
      hit = true;
    }
    return hit ? cfg : null;
  } catch {
    return null;
  }
}

function activeProvider(cfg: AppFileConfig): ModelProvider | null {
  const list = cfg.model.providers;
  if (!list.length) return null;
  return list.find((p) => p.id === cfg.model.activeId) ?? list[0] ?? null;
}

export function isAppConfigFileMode(): boolean {
  return fileMode;
}

export function isAppConfigReady(): boolean {
  return ready;
}

export function getCachedAppConfig(): AppFileConfig {
  // 首帧（hydrateAppConfig 还没回来）先用上次写进 localStorage 的整份配置占位，
  // 否则菜单会先按默认顺序画一遍、等文件配置回来后重排，看起来像「刷新后闪一下」。
  if (!cache) primeCacheFromStorage();
  return cache ?? emptyAppConfig();
}

/** 同步读 localStorage 填充缓存：只用于首屏，权威值仍由 hydrateAppConfig 覆盖 */
function primeCacheFromStorage(): void {
  if (primedFromLs) return;
  primedFromLs = true;
  if (typeof window === 'undefined') return;
  try {
    const cfg = readLsConfig();
    if (cfg) cache = cfg;
  } catch {
    // 隐私模式等，退回内存默认值
  }
}

export function getCachedApiKey(): string {
  return apiKeyCache;
}

export function listModelProviders(): ModelProvider[] {
  return [...(cache?.model.providers ?? [])];
}

/**
 * 启动时调用：优先文件中间件，否则 localStorage / 旧数据迁移。
 */
export async function hydrateAppConfig(): Promise<AppFileConfig> {
  try {
    const res = await fetch(CONFIG_API, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      const data = (await res.json()) as {
        config?: Partial<AppFileConfig>;
        apiKey?: string;
      };
      cache = normalizeConfig(data.config);
      const active = activeProvider(cache);
      const envKey = String(data.apiKey ?? '').trim();
      // 服务端可能把 .env 合成到 apiKey；优先写入当前激活提供商（仅内存展示用）
      apiKeyCache = envKey || active?.apiKey?.trim() || '';
      if (envKey && active && !active.apiKey) {
        // .env 覆盖展示，不强制改写文件除非用户保存
        apiKeyCache = envKey;
      }
      fileMode = true;
      writeLsConfig(cache);
      ready = true;
      return cache;
    }
  } catch {
    // fall through
  }

  fileMode = false;
  let cfg = readLsConfig();
  if (!cfg) cfg = migrateLegacyLocalStorage() ?? emptyAppConfig();
  cache = cfg;
  apiKeyCache = activeProvider(cfg)?.apiKey?.trim() || readLsApiKey();
  writeLsConfig(cache);
  ready = true;
  return cache;
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;

async function persistNow(cfg: AppFileConfig): Promise<void> {
  writeLsConfig(cfg);
  if (!fileMode) return;
  try {
    await fetch(CONFIG_API, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: cfg }),
    });
  } catch {
    // ignore
  }
}

/** 更新配置并防抖写回本地文件 */
export function updateAppConfig(patch: Partial<AppFileConfig>): AppFileConfig {
  const cur = cache ?? emptyAppConfig();
  const next = normalizeConfig({
    ...cur,
    ...patch,
    model: patch.model
      ? {
          ...cur.model,
          ...patch.model,
          providers: patch.model.providers ?? cur.model.providers,
        }
      : cur.model,
    general: { ...cur.general, ...(patch.general ?? {}) },
    plugins: { ...cur.plugins, ...(patch.plugins ?? {}) },
    caseTypes: patch.caseTypes ?? cur.caseTypes,
    promptKinds: patch.promptKinds ?? cur.promptKinds,
    knowledgeCategories: patch.knowledgeCategories ?? cur.knowledgeCategories,
    navGroups: patch.navGroups ?? cur.navGroups,
    navIcons: patch.navIcons ?? cur.navIcons,
    navOrder: patch.navOrder ?? cur.navOrder,
  });
  cache = next;
  const active = activeProvider(next);
  apiKeyCache = active?.apiKey?.trim() || '';
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persistNow(next);
  }, 280);
  return next;
}

export function flushAppConfig(): Promise<void> {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  return persistNow(cache ?? emptyAppConfig());
}

export function setRuntimeApiKey(key: string): void {
  apiKeyCache = key.trim();
  if (!fileMode) writeLsApiKey(apiKeyCache);
  if (!cache) return;
  const providers = cache.model.providers.map((p) =>
    p.id === cache!.model.activeId ? { ...p, apiKey: apiKeyCache || undefined } : p,
  );
  cache = normalizeConfig({
    ...cache,
    model: { ...cache.model, providers },
  });
}

export function settingsFromCache(): LLMSettings | null {
  const cfg = cache;
  if (!cfg) return null;
  const p = activeProvider(cfg);
  if (!p?.baseURL?.trim() || !p.model?.trim()) return null;
  const key = (p.apiKey || apiKeyCache).trim();
  if (!key) return null;
  return {
    baseURL: p.baseURL.trim(),
    apiKey: key,
    model: p.model.trim(),
    reasoningEffort: cfg.model.reasoningEffort,
    availableModels: p.availableModels,
  };
}

export function newProviderId(): string {
  return uid();
}

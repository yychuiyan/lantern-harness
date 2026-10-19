/**
 * 内置插件注册表：开关存应用配置（本地文件 / localStorage 回退）。
 * 插件随仓库发布，不提供远程安装/更新。
 * 新增插件：更新 PLUGIN_CATALOG，并在 config/app.defaults.json 的 plugins 中补默认值。
 *
 * 注意 `defaultEnabled` 只是「配置里没有这个开关时」的回退值（兼容老空间）；
 * 新建空间的默认开关以 config/app.defaults.json 为准（默认全部关闭，只有「提示词管理」例外：
 * 每个空间都要有默认提示词，因此它是内置常开项）。
 * 新插件同样写 false：升级后不会悄悄打开，由用户在「我的插件」里手动开启。
 */
import { getCachedAppConfig, updateAppConfig, flushAppConfig } from './app-config';

export type PluginId =
  | 'cases'
  | 'prompts'
  | 'knowledgeLib'
  | 'requirements'
  | 'templates'
  | 'memory'
  | 'knowledge'
  | 'caseGen'
  | 'promptGen'
  | 'knowledgeGen'
  | 'pluginDev'
  | 'todos'
  | 'tasks'
  | 'projects'
  | 'iterations'
  | 'pmRequirements'
  | 'bugs'
  | 'reports'
  | 'testStats'
  | 'caseExec'
  | 'dashboard';

/** 插件页的分类（声明顺序即展示顺序） */
export const PLUGIN_CATEGORIES = [
  '内容库',
  '生成能力',
  '记忆与检索',
  '待办与效率',
  '项目管理',
  '测试统计',
  '仪表盘',
  '开发工具',
] as const;
export type PluginCategory = (typeof PLUGIN_CATEGORIES)[number];

export interface PluginMeta {
  id: PluginId;
  name: string;
  description: string;
  version: string;
  /** 插件页分组标题 */
  category: PluginCategory;
  /** 是否依赖本地中间件 */
  requiresDev: boolean;
  /** 首次访问时的默认开关 */
  defaultEnabled: boolean;
  /** 内置常开项：不受空间配置影响，插件页不提供开关 */
  alwaysOn?: boolean;
  /** 可在输入框「/」唤起并打开面板 */
  hasPanel?: boolean;
  /** 依赖的插件：依赖关闭时本项视为关闭 */
  requires?: PluginId;
}

export const PLUGIN_CATALOG: PluginMeta[] = [
  {
    id: 'cases',
    category: '内容库',
    name: '用例管理',
    description:
      '侧栏进入用例库：浏览、搜索、打开与删除用例。关闭后入口隐藏，「生成测试用例」一并关闭；磁盘文件仍保留。',
    version: '0.1.0',
    requiresDev: true,
    defaultEnabled: false,
  },
  {
    id: 'caseGen',
    category: '生成能力',
    name: '生成测试用例',
    description:
      '在工作台用「/」打开配置：选类型、模板与提示词后生成用例并写入用例库。需同时开启「用例管理」。',
    version: '0.1.0',
    requiresDev: true,
    defaultEnabled: false,
    hasPanel: true,
    requires: 'cases',
  },
  {
    id: 'prompts',
    category: '内容库',
    name: '提示词管理',
    description:
      '侧栏进入提示词库：浏览、搜索、打开与删除提示词，并维护当前空间的「默认提示词」。每个空间都需要，因此默认开启且不可关闭；「生成提示词」仍是独立开关。',
    version: '0.1.0',
    requiresDev: true,
    defaultEnabled: true,
    alwaysOn: true,
  },
  {
    id: 'promptGen',
    category: '生成能力',
    name: '生成提示词',
    description:
      '用「/」打开配置后对话生成提示词；质检通过后写入提示词库。需同时开启「提示词管理」。',
    version: '0.1.0',
    requiresDev: true,
    defaultEnabled: false,
    hasPanel: true,
    requires: 'prompts',
  },
  {
    id: 'knowledgeLib',
    category: '内容库',
    name: '知识库管理',
    description:
      '侧栏进入知识库：浏览、搜索、打开与删除文档。关闭后入口隐藏，「生成知识库」一并关闭；磁盘文件仍保留。',
    version: '0.1.0',
    requiresDev: true,
    defaultEnabled: false,
  },
  {
    id: 'knowledgeGen',
    category: '生成能力',
    name: '生成知识库',
    description:
      '用「/」打开配置后对话生成规范、方法论或环境约定；质检通过后写入知识库。需同时开启「知识库管理」。',
    version: '0.1.0',
    requiresDev: true,
    defaultEnabled: false,
    hasPanel: true,
    requires: 'knowledgeLib',
  },
  {
    id: 'requirements',
    category: '内容库',
    name: '需求文档库',
    description:
      '侧栏进入需求文档库：浏览、搜索、上传与整理需求文档。关闭后入口隐藏；磁盘文件仍保留，生成用例时也不再引用。',
    version: '0.1.0',
    requiresDev: true,
    defaultEnabled: false,
  },
  {
    id: 'templates',
    category: '内容库',
    name: '测试模板库',
    description:
      '侧栏进入测试模板库：浏览、上传与整理用例 / 报告模板。关闭后入口隐藏；磁盘文件仍保留，生成用例时不再选用模板。',
    version: '0.1.0',
    requiresDev: true,
    defaultEnabled: false,
  },
  {
    id: 'knowledge',
    category: '记忆与检索',
    name: '知识库检索',
    description:
      '工作台输入「@」引用知识库与模板文档；发送后由模型按需读取。关闭后 @ 只列工作区文件。',
    version: '1.4.0',
    requiresDev: false,
    defaultEnabled: false,
  },
  {
    id: 'memory',
    category: '记忆与检索',
    name: '会话记忆',
    description:
      '五轨记忆（用户档案 / 全局事实 / 项目关键 / 项目日志 / 每日）：待确认、归档与便签，在工作台「记忆」Tab 管理。',
    version: '2.0.0',
    requiresDev: true,
    defaultEnabled: false,
  },
  {
    id: 'todos',
    category: '待办与效率',
    name: '待办事项',
    description:
      '侧栏进入待办事项：按状态 / 紧急程度筛选、行内改状态与手动维护；工作台会话也能通过工具直接记录与更新同一份待办。关闭后入口隐藏，磁盘数据仍保留。',
    version: '0.1.0',
    requiresDev: true,
    defaultEnabled: false,
  },
  {
    id: 'tasks',
    category: '待办与效率',
    name: '任务管理',
    description:
      '侧栏进入任务列表：按任务池 / 进行中 / 已完成 / 已关闭 / 已取消跟踪任务，并汇总每个任务下关联待办的数量与完成进度。关闭后入口隐藏，磁盘数据仍保留。',
    version: '0.1.0',
    requiresDev: true,
    defaultEnabled: false,
  },
  {
    id: 'reports',
    category: '待办与效率',
    name: '工作汇报',
    description:
      '打开后在工作台注入「工作汇报提示词」，并把这份提示词写进提示词管理，方便随时修改；关闭时只停用，提示词文件保留。',
    version: '0.1.0',
    requiresDev: true,
    defaultEnabled: false,
  },
  {
    id: 'projects',
    category: '项目管理',
    name: '项目列表',
    description:
      '侧栏进入项目列表：进度 / 规划 / 归档三种状态的项目卡片，汇总每个项目下的迭代、需求与缺陷数量；支持搜索、归档与删除。关闭后入口隐藏，数据仍保留。',
    version: '0.1.0',
    requiresDev: true,
    defaultEnabled: false,
  },
  {
    id: 'iterations',
    category: '项目管理',
    name: '迭代管理',
    description:
      '侧栏进入迭代管理：按项目维护迭代的开始 / 截止日期与状态，按日期流逝算进度并标出逾期。需同时开启「项目列表」。关闭后入口隐藏，数据仍保留。',
    version: '0.1.0',
    requiresDev: true,
    defaultEnabled: false,
    requires: 'projects',
  },
  {
    id: 'pmRequirements',
    category: '项目管理',
    name: '需求管理',
    description:
      '侧栏进入需求管理：按项目 / 迭代维护需求编号、优先级、状态与验收标准；需求挂在项目下，可关联迭代。需同时开启「项目列表」。关闭后入口隐藏，数据仍保留。',
    version: '0.1.0',
    requiresDev: true,
    defaultEnabled: false,
    requires: 'projects',
  },
  {
    id: 'bugs',
    category: '项目管理',
    name: '缺陷管理',
    description:
      '侧栏进入缺陷管理：按项目 / 迭代 / 需求记录缺陷，含严重程度、状态、重现步骤、期望与实际结果；关闭后入口隐藏，数据仍保留。需同时开启「项目列表」。',
    version: '0.1.0',
    requiresDev: true,
    defaultEnabled: false,
    requires: 'projects',
  },
  {
    id: 'testStats',
    category: '测试统计',
    name: '测试统计',
    description:
      '侧栏进入测试统计：按当前日期与测试统计维度（功能用例 / 自动化用例 / 接口用例 / 测试报告 / 缺陷统计等）记录统计数量，维度可搜索或直接创建。打开开关即在当前空间生成 测试统计/测试统计.json。关闭后入口隐藏，磁盘数据仍保留。',
    version: '0.1.0',
    requiresDev: true,
    defaultEnabled: false,
  },
  {
    id: 'caseExec',
    category: '测试统计',
    name: '用例执行统计',
    description:
      '侧栏进入用例执行统计：按项目记录用例总数、待执行与已执行数量，自动计算当前剩余用例与执行比例；项目名称可搜索或直接创建。打开开关即在当前空间生成 用例执行统计/用例执行统计.json。关闭后入口隐藏，磁盘数据仍保留。',
    version: '0.1.0',
    requiresDev: true,
    defaultEnabled: false,
  },
  {
    id: 'dashboard',
    category: '仪表盘',
    name: '仪表盘',
    description:
      '侧栏进入仪表盘：把当前空间的待办、任务、项目与测试统计聚合成一页（指标卡、倒计时、今日待办、进行中任务、测试统计柱状图、飞书式待办日历）。首次打开是空白画布，需在「编辑组件」里自行添加卡片；待办 / 任务为表格 + 分页。卡片摆在 12 列自由画布上，按住顶部圆点手柄拖位置、拖右下角把手改宽高，挡住相邻卡片时松手把它们挤开或让位；布局按空间记在浏览器本地。关闭后入口隐藏，数据仍保留。',
    version: '0.1.0',
    requiresDev: true,
    defaultEnabled: false,
  },
  {
    id: 'pluginDev',
    category: '开发工具',
    name: '插件开发',
    description:
      '用固定提示词开发扩展插件：先评估形态与范围并用选项确认，确认后才改代码，完成后并入「扩展插件」。需要读写项目源码。',
    version: '0.1.0',
    requiresDev: true,
    defaultEnabled: false,
    hasPanel: true,
  },
];

/** 按分类分组，用于插件页的段落标题（空分类不出现） */
export function groupPluginsByCategory(
  list: readonly PluginMeta[] = PLUGIN_CATALOG,
): { category: PluginCategory; items: PluginMeta[] }[] {
  return PLUGIN_CATEGORIES.map((category) => ({
    category,
    items: list.filter((p) => p.category === category),
  })).filter((g) => g.items.length > 0);
}

const EVENT = 'tw-plugins-changed';

function defaults(): Record<PluginId, boolean> {
  const map = {} as Record<PluginId, boolean>;
  for (const p of PLUGIN_CATALOG) map[p.id] = p.defaultEnabled;
  return map;
}

/** 应用依赖：打开子项时带上父项；关闭父项时关掉子项；父项关着则子项视为关 */
export function applyPluginDependencies(
  map: Record<PluginId, boolean>,
  changed?: { id: PluginId; enabled: boolean },
): Record<PluginId, boolean> {
  const next = { ...map };
  if (changed && !getPluginMeta(changed.id)?.alwaysOn) {
    next[changed.id] = changed.enabled;
    if (changed.enabled) {
      const req = getPluginMeta(changed.id)?.requires;
      if (req) next[req] = true;
    } else {
      for (const p of PLUGIN_CATALOG) {
        if (p.requires === changed.id) next[p.id] = false;
      }
    }
  }
  for (const p of PLUGIN_CATALOG) {
    if (p.alwaysOn) next[p.id] = true;
  }
  for (const p of PLUGIN_CATALOG) {
    if (p.requires && !next[p.requires]) next[p.id] = false;
  }
  return next;
}

export function loadPluginEnabled(): Record<PluginId, boolean> {
  const base = defaults();
  const fromFile = getCachedAppConfig().plugins ?? {};
  for (const p of PLUGIN_CATALOG) {
    if (typeof fromFile[p.id] === 'boolean') base[p.id] = fromFile[p.id]!;
  }
  return applyPluginDependencies(base);
}

export function isPluginEnabled(id: PluginId): boolean {
  return loadPluginEnabled()[id];
}

export function setPluginEnabled(id: PluginId, enabled: boolean): Record<PluginId, boolean> {
  if (getPluginMeta(id)?.alwaysOn) return loadPluginEnabled();
  const next = applyPluginDependencies(loadPluginEnabled(), { id, enabled });
  updateAppConfig({ plugins: next });
  void flushAppConfig();
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(EVENT, { detail: next }));
  }
  return next;
}

export function onPluginEnabledChanged(cb: (map: Record<PluginId, boolean>) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<Record<PluginId, boolean>>).detail;
    cb(detail ?? loadPluginEnabled());
  };
  window.addEventListener(EVENT, handler);
  return () => {
    window.removeEventListener(EVENT, handler);
  };
}

export function getPluginMeta(id: PluginId): PluginMeta | undefined {
  return PLUGIN_CATALOG.find((p) => p.id === id);
}

/** 插件未启用时的拦截文案 */
export function pluginDisabledMessage(id: PluginId): string {
  const meta = getPluginMeta(id);
  const name = meta?.name ?? id;
  if (meta?.requires && !isPluginEnabled(meta.requires)) {
    const parent = getPluginMeta(meta.requires)?.name ?? meta.requires;
    return `请先在「我的插件」中启用「${parent}」`;
  }
  return `请先在「我的插件」中启用「${name}」`;
}

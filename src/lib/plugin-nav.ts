/**
 * 按扩展插件开关隐藏侧栏入口（任务 / 待办 / 工作汇报 / 用例 / 提示词 / 知识库 / 需求文档 / 测试模板）。
 */
import { hydrateAppConfig } from './app-config';
import { isPluginEnabled, onPluginEnabledChanged, type PluginId } from './plugins';

/** 有侧栏入口的插件；关闭时给 <html> 打上 data-plugin-off-* 供 CSS 隐藏 */
const NAV_PLUGINS: PluginId[] = [
  'tasks',
  'todos',
  'reports',
  'testStats',
  'caseExec',
  'cases',
  'prompts',
  'knowledgeLib',
  'requirements',
  'templates',
];

/** dataset 键用驼峰，写到 HTML 上会被转成 data-plugin-off-requirements 这样的短横线形式 */
function navOffKey(id: PluginId): string {
  return `pluginOff${id.charAt(0).toUpperCase()}${id.slice(1)}`;
}

function applyPluginNav() {
  const root = document.documentElement;
  for (const id of NAV_PLUGINS) {
    const key = navOffKey(id);
    if (isPluginEnabled(id)) delete root.dataset[key];
    else root.dataset[key] = '1';
  }
}

export function initPluginNav() {
  applyPluginNav();
  onPluginEnabledChanged(() => applyPluginNav());
  void hydrateAppConfig().then(() => applyPluginNav());
  document.addEventListener('astro:page-load', applyPluginNav);
}

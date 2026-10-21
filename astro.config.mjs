// @ts-check
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';
import { lhMemoryPlugin } from './lh-plugins/lh-memory.mjs';
import { lhKbPlugin } from './lh-plugins/lh-kb.mjs';
import { lhBashPlugin } from './builtin/session/lh-bash.mjs';
import { lhFsPlugin } from './builtin/session/lh-fs.mjs';
import { lhSchedulePlugin } from './builtin/session/lh-schedule.mjs';
import { lhSpillPlugin } from './builtin/session/lh-spill.mjs';
import { lhWebPlugin } from './builtin/session/lh-web.mjs';
import { tbSessionRunsPlugin } from './builtin/session/session-runs.mjs';
import { lhSpacesPlugin } from './builtin/session/lh-spaces.mjs';
import { lhNavGroupsPlugin } from './builtin/session/lh-nav-groups.mjs';
import { lhTodosPlugin } from './lh-plugins/lh-todos.mjs';
import { lhTasksPlugin } from './lh-plugins/lh-tasks.mjs';
import { lhPmPlugin } from './lh-plugins/lh-pm.mjs';
import { lhReportsPlugin } from './lh-plugins/lh-reports.mjs';
import { lhStatsPlugin } from './lh-plugins/lh-stats.mjs';
import { lhUiautoPlugin } from './lh-plugins/lh-uiauto.mjs';
import { lhReqAnalysisPlugin } from './lh-plugins/lh-req-analysis.mjs';
import { lhUpdatePlugin } from './lh-plugins/lh-update.mjs';
import { lhConfigPlugin } from './lh-plugins/lh-config.mjs';
import { lhResourcesPlugin } from './lh-plugins/lh-resources.mjs';
import {
  lhCasesPlugin,
  lhKnowledgePlugin,
  lhPromptsPlugin,
  lhRequirementsPlugin,
  lhTemplatesPlugin,
} from './lh-plugins/lh-project-docs.mjs';
import { prepareSpacesRoot } from './cli/data-root.mjs';

const PROJECT_ROOT = path.dirname(fileURLToPath(import.meta.url));

// 公共空间落在仓库根/空间池/下。这里先铺好骨架（含旧布局迁移），
// 保证内容集合的 glob 基准目录一定存在，dev / build 都不至于空目录报错。
prepareSpacesRoot(PROJECT_ROOT);

// BASE_PATH 由 GitHub Actions 注入为 /<仓库名>（项目站点子路径），
// 本地开发不设置，默认 '/'
export default defineConfig({
  output: 'static',
  base: process.env.BASE_PATH ?? '/',
  /** 开发环境固定 IPv4，避免只监听 [::1] 导致 127.0.0.1 / 回环工具失败 */
  server: {
    host: '127.0.0.1',
    port: 4321,
  },
  /** 开发环境右下角 Astro 工具条（审计/设置等） */
  devToolbar: { enabled: false },
  /** 站内链接悬停预取，配合 ClientRouter 减少「每次整页重载」感 */
  prefetch: {
    prefetchAll: true,
    defaultStrategy: 'hover',
  },
  integrations: [react()],
  vite: {
    server: {
      watch: {
        // 业务内容目录由库页 API 自刷新；监听它们会在增删文件时整页 HMR
        ignored: [
          '**/AGENTS.md',
          '**/AGENTS.local.md',
          '**/CLAUDE.md',
          '**/CLAUDE.local.md',
          '**/空间池/**',
          '**/公共空间/**',
          '**/.lantern/**',
          '**/.tb/**',
          '**/.local/**',
          '**/用例管理/**',
          '**/知识库管理/**',
          '**/提示词管理/**',
          '**/需求文档库/**',
          '**/测试模板库/**',
        ],
      },
    },
    plugins: [
      tailwindcss(),
      tbSessionRunsPlugin(),
      // 数据空间上下文必须最先初始化，其余插件靠它取当前数据根
      lhSpacesPlugin(),
      lhTodosPlugin(),
      lhTasksPlugin(),
      lhPmPlugin(),
      lhReportsPlugin(),
      lhStatsPlugin(),
      lhUiautoPlugin(),
      lhReqAnalysisPlugin(),
      lhUpdatePlugin(),
      lhNavGroupsPlugin(),
      lhConfigPlugin(),
      lhResourcesPlugin(),
      lhMemoryPlugin(),
      lhKbPlugin(),
      lhFsPlugin(),
      lhBashPlugin(),
      lhSchedulePlugin(),
      lhSpillPlugin(),
      lhWebPlugin(),
      lhRequirementsPlugin(),
      lhCasesPlugin(),
      lhTemplatesPlugin(),
      lhPromptsPlugin(),
      lhKnowledgePlugin(),
    ],
  },
  markdown: {
    shikiConfig: {
      theme: 'github-light',
    },
  },
});

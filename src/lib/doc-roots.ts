/**
 * 文档根：磁盘为中文目录，界面为中文 label。
 * DocsRoot 英文 id 与 path 解耦（id 用于代码 / API，path 是盘上真实目录名）。
 */
import type { DocsRoot } from './project-docs';

export interface DocRootMeta {
  /** 数据空间目录下的真实目录名（中文） */
  path: string;
  /** 侧栏 / 文案展示名（中文） */
  label: string;
  /** 旧目录名（英文 / 中文短名等），启动时可自动迁移到 path */
  legacyPaths: string[];
}

export const DOC_ROOT_META: Record<DocsRoot, DocRootMeta> = {
  cases: {
    path: '用例管理',
    label: '用例管理',
    legacyPaths: ['cases', '用例'],
  },
  requirements: {
    path: '需求文档库',
    label: '需求文档库',
    legacyPaths: ['requirements', '需求'],
  },
  prompts: {
    path: '提示词管理',
    label: '提示词管理',
    legacyPaths: ['prompts', '提示词'],
  },
  knowledge: {
    path: '知识库管理',
    label: '知识库管理',
    legacyPaths: ['knowledge', '知识库'],
  },
  templates: {
    path: '测试模板库',
    label: '测试模板库',
    legacyPaths: ['templates', '模板'],
  },
  testReports: {
    path: '报告管理',
    label: '报告管理',
    legacyPaths: ['testReports', '测试报告管理'],
  },
};

export const DOC_ROOT_ORDER: DocsRoot[] = [
  'requirements',
  'cases',
  'prompts',
  'knowledge',
  'templates',
  'testReports',
];

export function docRootLabel(root: DocsRoot): string {
  return DOC_ROOT_META[root]?.label ?? root;
}

/** 展示用中文路径前缀，如「知识库管理/」 */
export function docRootLabelPath(root: DocsRoot): string {
  return `${docRootLabel(root)}/`;
}

/** 磁盘相对路径前缀，如 知识库管理/ */
export function docRootFsPrefix(root: DocsRoot): string {
  return `${DOC_ROOT_META[root]?.path ?? root}/`;
}

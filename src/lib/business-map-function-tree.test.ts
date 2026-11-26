import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { BusinessDirectory, BusinessFunction } from './business-map';

(globalThis as { React?: typeof React }).React = React;
const { default: BusinessMapFunctionTree } =
  await import('../components/islands/BusinessMapFunctionTree');

const base = {
  source: 'manual' as const,
  entryUrl: '',
  evidence: [],
  createdAt: '',
  updatedAt: '',
};

const directories: BusinessDirectory[] = [
  { ...base, id: 'home', parentId: '', name: '首页', order: 0, menuPath: ['首页'] },
  {
    ...base,
    id: 'intake',
    parentId: '',
    name: '工单受理',
    order: 1,
    menuPath: ['工单受理'],
  },
  {
    ...base,
    id: 'new',
    parentId: 'intake',
    name: '新建工单',
    order: 0,
    menuPath: ['工单受理', '新建工单'],
  },
  {
    ...base,
    id: 'dispatch',
    parentId: '',
    name: '派单处理',
    order: 2,
    menuPath: ['派单处理'],
  },
];

const functions = [
  { id: 'home-fn', name: '首页', code: 'F-002', directoryId: 'home', order: 0 },
  { id: 'notice-fn', name: '消息通知', code: 'F-084', directoryId: 'home', order: 1 },
  { id: 'query-fn', name: '工单查询', code: 'F-003', directoryId: 'intake', order: 1 },
  { id: 'dispatch-fn', name: '派单处理', code: 'F-005', directoryId: 'dispatch', order: 0 },
  { id: 'dispatch-query-fn', name: '派单查询', code: 'F-006', directoryId: 'dispatch', order: 1 },
].map(
  (item) =>
    ({
      ...item,
      confirmed: false,
    }) as BusinessFunction,
);

function render(
  expanded: string[],
  functionOverrides: Record<string, Partial<BusinessFunction>> = {},
) {
  return renderToStaticMarkup(
    React.createElement(BusinessMapFunctionTree, {
      directories,
      functions: functions.map((fn) =>
        functionOverrides[fn.id] ? { ...fn, ...functionOverrides[fn.id] } : fn,
      ),
      query: '',
      menuNavigation: [
        { label: '首页', order: 0 },
        { label: '工单查询', order: 1 },
        { label: '新建工单(灾备)', order: 3 },
        { label: '工单受理', order: 4 },
        { label: '新建工单', order: 5 },
        { label: '派单处理', order: 6 },
        { label: '派单查询', order: 7 },
      ],
      selectedDirectoryId: 'home',
      selectedFunctionId: 'home-fn',
      expandedIds: new Set(expanded),
      onSelectDirectory() {},
      onSelectFunction() {},
      onToggleDirectory() {},
      onCreateDirectory() {},
      onRenameDirectory() {},
      onCreateFunction() {},
      onDeleteDirectory() {},
      onUnlockMenu() {},
      onMove() {},
    }),
  );
}

describe('业务地图功能目录层级', () => {
  it('没有子目录的首页独立显示，不生成下拉箭头', () => {
    const html = render([]);
    const homeButton = html.match(
      /<button type="button" class="tw-bm-tree-select"[^>]*>(?:(?!<\/button>).)*首页(?:(?!<\/button>).)*<\/button>/s,
    )?.[0];
    assert.ok(homeButton);
    assert.doesNotMatch(homeButton, /aria-expanded=/);
    assert.doesNotMatch(homeButton, /tw-bm-tree-chevron/);
    assert.doesNotMatch(homeButton, /tw-bm-tree-folder/);
    assert.match(homeButton, /tw-bm-tree-leaf-icon/);
  });

  it('有子目录的节点下拉显示，导航顺序不再把普通功能提升到根级', () => {
    const html = render([]);
    assert.ok(html.indexOf('首页') < html.indexOf('工单受理'));
    const parentButton = html.match(
      /<button type="button" class="tw-bm-tree-select"[^>]*>(?:(?!<\/button>).)*工单受理(?:(?!<\/button>).)*<\/button>/s,
    )?.[0];
    assert.ok(parentButton);
    assert.match(parentButton, /aria-expanded="false"/);
    assert.match(parentButton, /tw-bm-tree-chevron/);
    assert.match(html, /aria-hidden="true" inert=""><div class="tw-collapse-inner"/);
    assert.match(render(['intake']), /class="tw-collapse is-open"/);
  });

  it('没有子目录但承载多个子菜单的功能组仍下拉，子项作为无箭头叶子菜单', () => {
    const html = render(['dispatch']);
    const dispatchButton = html.match(
      /<button type="button" class="tw-bm-tree-select"[^>]*>(?:(?!<\/button>).)*派单处理(?:(?!<\/button>).)*<\/button>/s,
    )?.[0];
    assert.ok(dispatchButton);
    assert.match(dispatchButton, /aria-expanded="true"/);
    assert.match(dispatchButton, /tw-bm-tree-chevron/);
    const functionButton = html.match(
      /<button type="button" class="tw-bm-tree-select"[^>]*>(?:(?!<\/button>).)*派单查询(?:(?!<\/button>).)*<\/button>/s,
    )?.[0];
    assert.ok(functionButton);
    assert.doesNotMatch(functionButton, /aria-expanded=/);
    assert.match(functionButton, /tw-bm-tree-leaf-icon/);
    assert.doesNotMatch(html, /tw-bm-tree-grip/);
    assert.match(html, /class="tw-bm-tree-row directory[^"]*"[^>]*draggable="true"/);
    assert.match(html, /class="tw-bm-tree-row function[^"]*"[^>]*draggable="true"/);
  });

  it('手工根级菜单顺序优先于系统采集顺序', () => {
    const html = render([], { 'query-fn': { menuOrder: 5.5 } });
    assert.ok(html.indexOf('工单受理') < html.indexOf('工单查询'));
    assert.ok(html.indexOf('工单查询') < html.indexOf('派单处理'));
  });

  it('人工移动后的功能显示菜单归属锁定入口', () => {
    const html = render([], {
      'query-fn': { lockedFields: ['directoryId', 'menuRoot'] },
    });
    assert.match(html, /菜单层级已锁定，点击恢复自动整理/);
    assert.match(html, /tw-bm-tree-menu-lock/);
    assert.ok(html.indexOf('tw-bm-tree-menu-lock') < html.indexOf('F-003'));
  });
});

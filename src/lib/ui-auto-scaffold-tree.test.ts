/**
 * 预览树：平铺清单 → 按骨架目录结构分组。
 *
 * 断言的是排序与汇总口径（目录在前、同层按名排、目录体积是子树合计），
 * 渲染细节不在这里测。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildPreviewTree, subtreeStats } from './ui-auto-scaffold-tree';

describe('预览按骨架结构分组', () => {
  it('多层目录折成树，同层目录在前、文件在后', () => {
    const tree = buildPreviewTree([
      { path: 'package.json', bytes: 2048 },
      { path: 'tests/smoke/login.spec.ts', bytes: 100 },
      { path: 'tests/auth.setup.ts', bytes: 50 },
      { path: 'tests/regression/login.spec.ts', bytes: 200 },
      { path: 'pages/BasePage.ts', bytes: 1331 },
      { path: '.github/workflows/playwright.yml', bytes: 900 },
    ]);
    assert.deepEqual(
      tree.map((node) => node.name),
      ['.github', 'pages', 'tests', 'package.json'],
    );
    const tests = tree.find((node) => node.name === 'tests');
    assert.ok(tests?.dir);
    assert.deepEqual(
      tests?.children.map((node) => node.name),
      ['regression', 'smoke', 'auth.setup.ts'],
    );
    const smoke = tests?.children.find((node) => node.name === 'smoke');
    assert.equal(smoke?.children[0].path, 'tests/smoke/login.spec.ts');
    assert.equal(smoke?.children[0].dir, false);
  });

  it('目录汇总递归算文件数与体积', () => {
    const tree = buildPreviewTree([
      { path: 'tests/smoke/a.spec.ts', bytes: 100 },
      { path: 'tests/smoke/b.spec.ts', bytes: 50 },
      { path: 'tests/regression/c.spec.ts', bytes: 25 },
    ]);
    const tests = tree[0];
    assert.deepEqual(subtreeStats(tests), { files: 3, bytes: 175, changed: 0 });
    const regression = tests.children.find((node) => node.name === 'regression');
    const smoke = tests.children.find((node) => node.name === 'smoke');
    assert.ok(regression && smoke);
    assert.deepEqual(subtreeStats(smoke), { files: 2, bytes: 150, changed: 0 });
    assert.deepEqual(subtreeStats(regression.children[0]), { files: 1, bytes: 25, changed: 0 });
  });

  it('修改项目：文件状态带进树，目录汇总有变更的条目数', () => {
    const tree = buildPreviewTree([
      { path: 'tests/smoke/a.spec.ts', bytes: 100, status: 'new' },
      { path: 'tests/smoke/b.spec.ts', bytes: 50, status: 'same' },
      { path: 'tests/regression/c.spec.ts', bytes: 25, status: 'changed' },
    ]);
    const tests = tree[0];
    assert.equal(subtreeStats(tests).changed, 2);
    const smoke = tests.children.find((node) => node.name === 'smoke');
    assert.equal(smoke?.children.find((node) => node.name === 'a.spec.ts')?.status, 'new');
    assert.equal(smoke?.children.find((node) => node.name === 'b.spec.ts')?.status, 'same');
  });

  it('Windows 分隔符与重复目录只建一个节点', () => {
    const tree = buildPreviewTree([
      { path: 'pages\\LoginPage.ts', bytes: 10 },
      { path: 'pages/HomePage.ts', bytes: 20 },
    ]);
    assert.equal(tree.length, 1);
    assert.equal(tree[0].name, 'pages');
    assert.equal(tree[0].children.length, 2);
  });

  it('空清单返回空树', () => {
    assert.deepEqual(buildPreviewTree([]), []);
  });
});

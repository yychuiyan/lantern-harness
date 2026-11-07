/**
 * 「新建提示词」相关的小工具回归：
 * 1. 文件名规整（补 .md、挡住目录穿越与保留字符）；
 * 2. 空白骨架必须能被三段解析认出来，否则建完等于没提示词。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildPromptSkeleton,
  normalizePromptFileName,
  parseUiAutoSections,
} from './ui-auto-prompt';

describe('normalizePromptFileName', () => {
  it('不写扩展名时补 .md', () => {
    assert.equal(normalizePromptFileName('接口自动化测试-pytest'), '接口自动化测试-pytest.md');
  });

  it('已经带 .md 不重复补', () => {
    assert.equal(normalizePromptFileName('自定义提示词.md'), '自定义提示词.md');
  });

  it('路径分隔符换成空格，不会跳出提示词目录', () => {
    assert.equal(normalizePromptFileName('a/b\\c.md'), 'a b c.md');
    assert.equal(normalizePromptFileName('../../etc/passwd'), '.. .. etc passwd.md');
  });

  it('保留字符与控制字符一并清掉', () => {
    assert.equal(normalizePromptFileName('  a*b?c\u0001d.md  '), 'a b c d.md');
  });

  it('空名字与超长名字返回空串，由调用方提示', () => {
    assert.equal(normalizePromptFileName('   '), '');
    assert.equal(normalizePromptFileName('x'.repeat(200)), '');
  });
});

describe('buildPromptSkeleton', () => {
  it('三段标题都能被解析成非空正文', () => {
    const sections = parseUiAutoSections(buildPromptSkeleton('接口自动化测试-pytest.md'));
    assert.ok(sections.plan.trim().length > 0);
    assert.ok(sections.agent.trim().length > 0);
    assert.ok(sections.code.trim().length > 0);
  });

  it('标题取文件名（去掉 .md）', () => {
    assert.match(buildPromptSkeleton('接口自动化测试-pytest.md'), /^# 接口自动化测试-pytest\n/);
  });
});

describe('pickFrameworkSection（项目骨架按框架取子段）', () => {
  const text = [
    '## 项目骨架',
    '',
    '共用约定：目录与标签以本节为准。',
    '',
    '### playwright',
    '',
    '页面对象放 pages/，标签用 @smoke。',
    '',
    '### pytest',
    '',
    '页面对象放 pages/*_page.py，不要写 @smoke。',
    '',
    '## 规划阶段',
    '',
    '规划正文',
  ].join('\n');

  it('命中当前框架：共用部分 + 该子段', () => {
    const sections = parseUiAutoSections(text, 'pytest');
    assert.match(sections.skeleton, /共用约定/);
    assert.match(sections.skeleton, /pages\/\*_page\.py/);
    assert.doesNotMatch(sections.skeleton, /标签用 @smoke/);
    // 其它段不受框架影响
    assert.equal(sections.plan, '规划正文');
  });

  it('有子段但没命中：只返回共用部分，不把别的框架的约定塞进来', () => {
    const sections = parseUiAutoSections(text, 'selenium');
    assert.equal(sections.skeleton, '共用约定：目录与标签以本节为准。');
  });

  it('没写 ### 子段的老提示词：整段返回（向后兼容）', () => {
    const legacy = ['## 项目骨架', '', '骨架: playwright-ts', '', '目录约定……'].join('\n');
    const out = parseUiAutoSections(legacy, 'pytest');
    assert.equal(out.skeleton, '骨架: playwright-ts\n\n目录约定……');
    // 不传框架、又没有子段时也照旧整段
    assert.equal(parseUiAutoSections(legacy).skeleton, '骨架: playwright-ts\n\n目录约定……');
  });
});

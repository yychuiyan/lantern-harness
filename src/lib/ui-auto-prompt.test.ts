/** 自动化技能分段解析回归。 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseUiAutoSections } from './ui-auto-prompt';

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

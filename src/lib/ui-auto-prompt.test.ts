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

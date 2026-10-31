/**
 * 提示词锁定规则：内置默认提示词永远保护；插件提示词只在插件开启时保护。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CHAT_SYSTEM_PROMPT_FILE,
  PLUGIN_PROMPT_FILES,
  isPluginPromptLocked,
  isPromptLocked,
  isPromptReferenced,
  promptLockedReason,
  promptOwnerKind,
  promptOwnerPlugin,
} from './prompts-meta';

describe('提示词锁定规则', () => {
  it('能认出插件归属', () => {
    assert.equal(promptOwnerPlugin('Playwright提示词.md'), 'uiAuto');
    assert.equal(promptOwnerPlugin('原文结构提示词.md'), 'reqAnalysis');
    assert.equal(promptOwnerPlugin('提示词管理/工作汇报提示词.md'), 'reports');
    assert.equal(promptOwnerPlugin('我自己的提示词.md'), undefined);
    // 旧名不再视为插件提示词：插件开着也不锁，可自行删掉
    assert.equal(promptOwnerPlugin('自动化测试提示词.md'), undefined);
  });

  it('插件开着才锁，关掉可删', () => {
    const on = { uiAuto: true, reports: false };
    assert.equal(isPluginPromptLocked('Playwright提示词.md', on), true);
    assert.equal(isPluginPromptLocked('工作汇报提示词.md', on), false);
    assert.equal(isPromptLocked('Playwright提示词.md', on), true);
    assert.equal(
      isPromptLocked('Playwright提示词.md', { uiAuto: false }),
      false,
      '关闭插件后应允许删除',
    );
  });

  it('默认提示词始终保护，并给出原因', () => {
    assert.equal(isPromptLocked(CHAT_SYSTEM_PROMPT_FILE, {}), true);
    assert.match(promptLockedReason(CHAT_SYSTEM_PROMPT_FILE, {}), /默认提示词/);
    assert.match(promptLockedReason('Playwright提示词.md', { uiAuto: true }), /关闭对应插件/);
    assert.equal(promptLockedReason('我自己的提示词.md', { uiAuto: true }), '');
  });

  it('映射表里每个文件都指向一个真实插件 id', () => {
    for (const [file, plugin] of Object.entries(PLUGIN_PROMPT_FILES)) {
      assert.ok(file.endsWith('.md'), `${file} 应是 markdown`);
      assert.ok(plugin && plugin.length > 0);
    }
  });

  it('项目挂载的提示词也算关联', () => {
    const mounted = { 'pytest提示词.md': 'uiAuto', '分组/接口提示词.md': 'reports' };
    assert.equal(promptOwnerKind('pytest提示词.md', mounted), 'uiAuto');
    assert.equal(promptOwnerKind('./分组/接口提示词.md', mounted), 'reports');
    // 文件名约定优先，不必依赖运行时挂载
    assert.equal(promptOwnerKind('Playwright提示词.md', {}), 'uiAuto');
    assert.equal(promptOwnerKind(CHAT_SYSTEM_PROMPT_FILE, mounted), 'system');
    // 没人挂载的用户提示词仍是「未关联」
    assert.equal(promptOwnerKind('随便写的.md', mounted), '');
    assert.equal(promptOwnerKind('pytest提示词.md'), '');
  });

  it('「引用中」只看真实挂载', () => {
    const mounted = { 'pytest提示词.md': 'uiAuto', '分组/接口提示词.md': 'reports' };
    assert.equal(isPromptReferenced('pytest提示词.md', mounted), true);
    assert.equal(isPromptReferenced('./分组/接口提示词.md', mounted), true);
    // 插件自带的那份，项目切走之后就不再是引用（换挂载即取消上一份）
    assert.equal(isPromptReferenced('Playwright提示词.md', mounted), false);
    assert.equal(isPromptReferenced('pytest提示词.md'), false);
  });
});

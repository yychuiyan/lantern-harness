import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildCasePromptSkeleton } from './case-prompt';

describe('功能用例技能种子', () => {
  it('保持人工执行口径，同时包含可自动化解析要求', () => {
    const text = buildCasePromptSkeleton('功能测试用例提示词.md');
    assert.match(text, /一条用例只验一个点/);
    assert.match(text, /步骤按序号一条只写一个业务动作/);
    assert.match(text, /不写 CSS \/ XPath \/ 坐标/);
    assert.match(text, /自动化阻塞/);
    assert.doesNotMatch(text, /Playwright|iteration|定位器|测试脚本/);
  });

  it('不会把功能界面的自动化要求注入接口或性能用例技能', () => {
    for (const name of ['接口测试用例提示词.md', '性能测试用例提示词.md']) {
      const text = buildCasePromptSkeleton(name);
      assert.doesNotMatch(text, /界面元素使用用户可见|自动化阻塞/);
    }
  });
});

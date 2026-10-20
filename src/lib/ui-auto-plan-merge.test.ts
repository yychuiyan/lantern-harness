/**
 * 计划 / 活动日志的「不许悄悄丢」回归测试。
 *
 * 起因：探索开始时模型会再提交一次 `ui_plan_steps`（有时少写几步、有时干脆传空），
 * 早先是整份覆盖用户的计划，页面一刷新看起来就是「规划步骤没了」；
 * 活动日志同理，前端状态没捞回来时只带两三条就整份覆盖，把上一轮记录抹掉。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mergePlanWithModel, normalizePlan } from '../../lh-plugins/uiauto-explorer/plan.mjs';
import { mergeActivityLog } from '../../lh-plugins/uiauto-explorer/sessions.mjs';
import { isBrowserClosedOutput } from './ui-auto-agent';

const userPlan = [
  { id: 'p1', action: 'goto', target: '商城首页', url: '/' },
  { id: 'p2', action: 'click', target: '商品列表入口' },
  { id: 'p3', action: 'expectUrl', target: '跳转到商品列表', url: '/goods' },
];

describe('mergePlanWithModel', () => {
  it('模型传空数组时保持原计划不动', () => {
    const merged = mergePlanWithModel(userPlan, []);
    assert.equal(merged.length, 3);
    assert.deepEqual(
      merged.map((step) => step.action),
      ['goto', 'click', 'expectUrl'],
    );
  });

  it('同 id 只吸收定位器 / 状态，不覆盖用户写的动作和目标', () => {
    const merged = mergePlanWithModel(userPlan, [
      {
        id: 'p2',
        action: 'expect',
        target: '模型自己改的目标',
        status: 'bound',
        locator: { kind: 'role', role: 'link', name: '商品列表' },
      },
    ]);
    const step = merged.find((item) => item.id === 'p2') as
      { action: string; target: string; status: string; locator?: unknown } | undefined;
    assert.ok(step);
    assert.equal(step.action, 'click');
    assert.equal(step.target, '商品列表入口');
    assert.equal(step.status, 'bound');
    assert.deepEqual(step.locator, { kind: 'role', role: 'link', name: '商品列表' });
  });

  it('模型少写几步也只是不更新，不会把步骤删掉', () => {
    const merged = mergePlanWithModel(userPlan, [
      { id: 'p1', action: 'goto', target: '商城首页', url: '/' },
    ]);
    assert.equal(merged.length, 3);
  });

  it('模型新增的步骤追加在后面', () => {
    const merged = mergePlanWithModel(userPlan, [
      { id: 'p1', action: 'goto', target: '商城首页', url: '/' },
      { id: 'p4', action: 'expect', target: '购物车里有该商品' },
    ]);
    assert.equal(merged.length, 4);
    assert.equal(merged[3].id, 'p4');
  });

  it('已绑定的步骤不会被模型打回 pending', () => {
    const bound = [{ id: 'p1', action: 'click', target: '按钮', status: 'bound' }];
    const merged = mergePlanWithModel(bound, [{ id: 'p1', action: 'click', target: '按钮' }]);
    assert.equal(merged[0].status, 'bound');
  });

  it('normalizePlan 仍然会丢掉非法动作（screenshot 不是计划动作）', () => {
    const plan = normalizePlan([{ action: 'screenshot', target: 'x' }, { action: 'nope' }]);
    assert.equal(plan.length, 0);
    const ok = normalizePlan([{ action: 'click', target: '按钮' }, { action: 'nope' }]);
    assert.equal(ok.length, 1);
  });
});

describe('mergeActivityLog', () => {
  const a = { kind: 'info', name: '规划步骤', detail: '3 步', status: 'done', at: 't1' };
  const b = { kind: 'tool', name: 'ui_browser_open', detail: '{}', status: 'done', at: 't2' };
  const c = { kind: 'error', name: '浏览器已关闭', detail: '', status: 'failed', at: 't3' };

  it('前端只带回最后几条时，老记录仍然保留', () => {
    const merged = mergeActivityLog([a, b], [c]);
    assert.deepEqual(
      merged.map((item) => item.name),
      ['规划步骤', 'ui_browser_open', '浏览器已关闭'],
    );
  });

  it('重复条目不会重复追加', () => {
    const merged = mergeActivityLog([a, b], [b, c]);
    assert.equal(merged.length, 3);
  });

  it('已有记录为空时直接用新的', () => {
    assert.deepEqual(
      mergeActivityLog([], [c]).map((item) => item.name),
      ['浏览器已关闭'],
    );
  });
});

describe('isBrowserClosedOutput', () => {
  it('主进程统一口径能识别', () => {
    assert.equal(
      isBrowserClosedOutput(JSON.stringify({ error: '浏览器已被关闭，探索已结束' })),
      true,
    );
  });

  it('Playwright 原生报错也能识别', () => {
    assert.equal(
      isBrowserClosedOutput(
        JSON.stringify({ error: 'page.goto: Target page, context or browser has been closed' }),
      ),
      true,
    );
  });

  it('页面快照里出现同样文案不算（只看 error 字段）', () => {
    assert.equal(
      isBrowserClosedOutput(JSON.stringify({ snapshot: '提示：浏览器已被关闭', elements: 1 })),
      false,
    );
  });

  it('普通错误不误判', () => {
    assert.equal(isBrowserClosedOutput(JSON.stringify({ error: '元素没找到' })), false);
    assert.equal(isBrowserClosedOutput('not json'), false);
  });
});

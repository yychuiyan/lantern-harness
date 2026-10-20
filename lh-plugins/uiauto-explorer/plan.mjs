/**
 * 步骤计划（Plan）：人看得懂的「做什么」，不含定位器。
 *
 * 为什么不直接让模型产 IR：
 * - 定位器必须由探索时的 `locator_probe` 现场校验，凭空写出来的值会把错误带进脚本；
 * - 计划可以给人改（增删 / 排序 / 改描述），IR 是机器产物，改起来门槛高。
 *
 * 计划绑定的定位器由 `/agent/probe` 回填，状态从 pending → bound。
 */
import { STEP_ACTIONS } from './ir.mjs';

/** 计划步允许的动作：截图是探索时给人看的工具动作，不是测试步骤 */
export const PLAN_ACTIONS = STEP_ACTIONS.filter((action) => action !== 'screenshot');

export const PLAN_STATUSES = ['pending', 'bound', 'done', 'failed'];

const MAX_PLAN_STEPS = 40;
const MAX_TARGET = 120;
const MAX_VALUE = 400;

/** 不需要目标的动作：整页级操作 */
const NO_TARGET_ACTIONS = new Set(['goto', 'wait', 'screenshot', 'press']);

const clean = (value) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * 把模型 / 前端给的计划归一化。
 * - 未知动作、缺目标（整页动作除外）直接丢掉
 * - id 缺失时按顺序补；重复 id 换新
 * - value 里的 `${ENV}` 原样保留，出码时才转成环境变量
 */
export function normalizePlan(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.steps) ? raw.steps : [];
  const used = new Set();
  const steps = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    if (steps.length >= MAX_PLAN_STEPS) break;
    const action = String(item.action ?? '').trim();
    if (!PLAN_ACTIONS.includes(action)) continue;
    const target = clean(item.target ?? item.label ?? item.note).slice(0, MAX_TARGET);
    if (!target && !NO_TARGET_ACTIONS.has(action)) continue;

    let id = clean(item.id)
      .replace(/[^\w-]/g, '')
      .slice(0, 40);
    if (!id || used.has(id)) {
      let seq = steps.length + 1;
      while (used.has(`p${seq}`)) seq += 1;
      id = `p${seq}`;
    }
    used.add(id);

    const step = { id, action, target, status: 'pending' };
    if (item.value != null && String(item.value) !== '') {
      step.value = String(item.value).slice(0, MAX_VALUE);
    }
    const url = clean(item.url);
    if (url) step.url = url.slice(0, 500);
    const note = clean(item.note);
    if (note && note !== target) step.note = note.slice(0, 200);
    if (PLAN_STATUSES.includes(item.status)) step.status = item.status;
    if (item.locator && typeof item.locator === 'object') step.locator = item.locator;
    if (item.warning) step.warning = clean(item.warning).slice(0, 200);
    steps.push(step);
  }
  return steps;
}

/**
 * 模型提交的计划合并进用户现有计划。
 *
 * 探索时模型会再调一次 `ui_plan_steps`（可能少写几步、改措辞、或干脆传空），
 * 早先直接覆盖整份计划：用户手改的动作 / 目标就这么没了，页面刷新后看起来
 * 「计划不见了」。这里的原则是**用户已经写下的内容优先**：
 * - 同 id：只吸收 status / locator / warning，动作和目标保持用户版
 * - 新 id：追加
 * - 模型传空：原样返回，绝不清空
 */
export function mergePlanWithModel(current, incoming) {
  const base = normalizePlan(current);
  const next = normalizePlan(incoming);
  if (!next.length) return base;
  const byId = new Map(next.map((step) => [step.id, step]));
  const merged = base.map((step) => {
    const patch = byId.get(step.id);
    if (!patch) return step;
    byId.delete(step.id);
    const out = { ...step };
    if (patch.locator) out.locator = patch.locator;
    if (patch.warning) out.warning = patch.warning;
    // 用户已经绑定过的步骤不要被模型打回 pending
    if (patch.status && !(step.status === 'bound' && patch.status === 'pending')) {
      out.status = patch.status;
    }
    return out;
  });
  for (const step of next) {
    if (!byId.has(step.id)) continue;
    merged.push(step);
    if (merged.length >= MAX_PLAN_STEPS) break;
  }
  return merged;
}

/** 计划里真正需要在页面上操作 / 断言的步骤（探索时要逐个 probe） */ export function planNeedsLocator(
  step,
) {
  return ['click', 'fill', 'select', 'hover', 'expect'].includes(step?.action);
}

/** 计划 → 给模型看的清单（探索和规划共用一份措辞） */
export function describePlan(plan) {
  if (!Array.isArray(plan) || !plan.length) return '';
  return plan
    .map((step, index) => {
      const parts = [`${index + 1}. [${step.id}] ${step.action}`];
      if (step.target) parts.push(`目标：${step.target}`);
      if (step.url) parts.push(`url=${step.url}`);
      if (step.value) parts.push(`值=${step.value}`);
      if (step.status === 'bound' && step.locator) {
        parts.push(`已绑定：${describeLocator(step.locator)}`);
      }
      return parts.join(' · ');
    })
    .join('\n');
}

/** 定位器的简短说明，给计划和活动日志用 */
export function describeLocator(locator) {
  if (!locator || typeof locator !== 'object') return '';
  const nth = Number.isInteger(locator.nth) ? ` nth=${locator.nth}` : '';
  if (locator.kind === 'role') {
    return `role=${locator.role}${locator.name ? ` name="${locator.name}"` : ''}${nth}`;
  }
  if (locator.kind === 'attr') return `[${locator.attr}="${locator.value}"]${nth}`;
  if (locator.kind === 'testid') return `testid=${locator.value}${nth}`;
  return `${locator.kind}="${locator.value ?? ''}"${nth}`;
}

/** 用探测结果回填某一步 */
export function bindPlanStep(plan, stepId, probe) {
  if (!Array.isArray(plan) || !stepId) return plan;
  return plan.map((step) => {
    if (step.id !== stepId) return step;
    const locator = probe?.recommended ?? null;
    if (!locator) {
      return {
        ...step,
        status: 'failed',
        warning: probe?.warning || '没有唯一候选，换一个更具体的元素',
      };
    }
    return {
      ...step,
      status: 'bound',
      locator,
      warning:
        probe?.confidence === 'high' ? '' : probe?.warning || '定位器不够稳，建议补 data-testid',
    };
  });
}

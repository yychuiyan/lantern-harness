/**
 * 步骤 IR：AI 只产出「做什么 + 定位谁」，代码由模板渲染。
 *
 * 为什么不让模型直接写脚本：
 * - 同一份 IR 可以同时出 TS 与 Python，换语言不用重跑模型
 * - 试跑失败后模型只需要改一个字段（定位器 / 等待），改代码容易牵一发动全身
 * - 代码风格、转义、环境变量读取都由模板保证，不受模型心情影响
 */

/** 允许的步骤动作 */
export const STEP_ACTIONS = [
  'goto',
  'click',
  'fill',
  'select',
  'press',
  'hover',
  'expect',
  'expectUrl',
  'wait',
  'screenshot',
];

const LOCATOR_ACTIONS = new Set(['click', 'fill', 'select', 'press', 'hover', 'expect']);

/** 需要定位器的动作里，没给 locator 的直接丢掉，避免生成必崩的脚本 */
export function normalizeIr(raw, fallback = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const steps = Array.isArray(source.steps) ? source.steps : [];
  const normalized = [];
  for (const step of steps) {
    if (!step || typeof step !== 'object') continue;
    const action = String(step.action ?? '').trim();
    if (!STEP_ACTIONS.includes(action)) continue;
    const locator = normalizeLocator(step.locator);
    if (LOCATOR_ACTIONS.has(action) && !locator) continue;
    normalized.push({
      action,
      locator: locator || undefined,
      url: typeof step.url === 'string' ? step.url : undefined,
      value: step.value == null ? undefined : String(step.value),
      key: typeof step.key === 'string' ? step.key : undefined,
      text: typeof step.text === 'string' ? step.text : undefined,
      state: step.state === 'hidden' ? 'hidden' : step.state === 'visible' ? 'visible' : undefined,
      ms: Number.isFinite(Number(step.ms)) ? Math.max(0, Number(step.ms)) : undefined,
      note: typeof step.note === 'string' ? step.note.slice(0, 200) : undefined,
      // 只用于把 IR 与左侧计划对齐，出码时忽略
      planStepId: typeof step.planStepId === 'string' ? step.planStepId.slice(0, 40) : undefined,
    });
  }
  return {
    title: String(source.title ?? fallback.title ?? '未命名流程').slice(0, 120),
    target: (source.target ?? fallback.target) === 'python' ? 'python' : 'ts',
    baseURL: String(source.baseURL ?? fallback.baseURL ?? ''),
    storageState: String(source.storageState ?? fallback.storageState ?? ''),
    source: String(source.source ?? fallback.source ?? '').slice(0, 2000),
    steps: normalized,
  };
}

export function normalizeLocator(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = String(raw.kind ?? '').trim();
  if (!['testid', 'role', 'label', 'placeholder', 'text', 'attr', 'css'].includes(kind))
    return null;
  const spec = { kind };
  if (kind === 'role') {
    const role = String(raw.role ?? '').trim();
    if (!role) return null;
    spec.role = role;
    if (raw.name != null && String(raw.name).trim()) {
      spec.name = String(raw.name).trim();
      spec.exact = raw.exact !== false;
    }
  } else if (kind === 'attr') {
    const attr = String(raw.attr ?? '').trim();
    const value = String(raw.value ?? '').trim();
    if (!attr || !value) return null;
    spec.attr = attr;
    spec.value = value;
  } else {
    const value = String(raw.value ?? '').trim();
    if (!value) return null;
    spec.value = value;
    if (kind === 'label' || kind === 'placeholder' || kind === 'text') {
      spec.exact = raw.exact !== false;
    }
  }
  if (Number.isInteger(raw.nth) && Number(raw.nth) >= 0) spec.nth = Number(raw.nth);
  return spec;
}

/** `${NAME}` 这类占位符 → 环境变量读取，避免把账号写死进脚本 */
export function splitEnvValue(value) {
  const text = String(value ?? '');
  const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(text.trim());
  return match ? match[1] : '';
}

/** 标题 → 文件名（ASCII，避免不同系统对中文文件名的处理差异） */
export function slugify(title) {
  const ascii = String(title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  if (ascii) return ascii;
  return 'ai-generated';
}

export function pythonFunctionName(title) {
  const slug = slugify(title).replace(/-/g, '_');
  return `test_${slug || 'ai_generated'}`;
}

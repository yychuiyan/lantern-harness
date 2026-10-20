/**
 * 定位器候选：把探索期的临时 ref 转成「能写进脚本」的 Playwright locator。
 *
 * 顺序遵循官方建议：testid → role+name → label → placeholder → text → 稳定属性 → 短 CSS。
 * 每个候选都要过两道校验：
 *   1. count() === 1 —— 唯一，脚本里不会点错元素
 *   2. 命中的元素就是刚才 ref 指的那个 —— 语义对得上，不是碰巧同名
 * 校验不通过的候选只保留信息，不会被推荐。
 */

/** 候选类型的默认权重，越大越稳 */
const KIND_SCORE = {
  testid: 100,
  role: 90,
  label: 80,
  placeholder: 70,
  text: 60,
  attr: 40,
  css: 20,
};

const ROLE_NAME_REQUIRED = new Set(['button', 'link', 'tab', 'menuitem', 'option', 'treeitem']);

function clean(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 纯函数：根据元素信息生成候选（不碰浏览器，方便单测） */
export function buildCandidateLocators(info) {
  const list = [];
  const push = (spec, source, score) => {
    if (!spec) return;
    const key = locatorKey(spec);
    if (list.some((item) => locatorKey(item.locator) === key)) return;
    list.push({ locator: spec, source, score });
  };

  const testId = clean(info.testId);
  if (testId) push({ kind: 'testid', value: testId }, 'data-testid', KIND_SCORE.testid);

  const role = clean(info.role);
  const name = clean(info.name);
  if (role && (!ROLE_NAME_REQUIRED.has(role) || name)) {
    if (name) {
      push({ kind: 'role', role, name, exact: true }, 'role + 精确名称', KIND_SCORE.role);
      push({ kind: 'role', role, name, exact: false }, 'role + 模糊名称', KIND_SCORE.role - 10);
    } else {
      push({ kind: 'role', role }, `role=${role}`, KIND_SCORE.role - 30);
    }
  }

  const label = clean(info.labelText);
  if (label) {
    push({ kind: 'label', value: label, exact: true }, 'label 精确', KIND_SCORE.label);
    push({ kind: 'label', value: label, exact: false }, 'label 模糊', KIND_SCORE.label - 10);
  }

  const placeholder = clean(info.placeholder);
  if (placeholder && placeholder !== name) {
    push(
      { kind: 'placeholder', value: placeholder, exact: true },
      'placeholder 精确',
      KIND_SCORE.placeholder,
    );
  }

  const text = clean(info.text);
  const textInput = role === 'textbox' || role === 'combobox' || role === 'searchbox';
  if (text && text.length <= 40 && !textInput) {
    push({ kind: 'text', value: text, exact: true }, 'text 精确', KIND_SCORE.text);
  }

  const nameAttr = clean(info.nameAttr);
  if (nameAttr && info.tag !== 'a') {
    push({ kind: 'attr', attr: 'name', value: nameAttr }, 'name 属性', KIND_SCORE.attr);
  }

  const href = clean(info.href);
  if (href && !href.startsWith('#') && href.length <= 80) {
    push({ kind: 'attr', attr: 'href', value: href }, 'href 属性', KIND_SCORE.attr - 5);
  }

  const ariaLabel = clean(info.ariaLabel);
  if (ariaLabel && ariaLabel !== name) {
    push(
      { kind: 'attr', attr: 'aria-label', value: ariaLabel },
      'aria-label 属性',
      KIND_SCORE.attr,
    );
  }

  const cssPath = clean(info.cssPath);
  if (cssPath) {
    push({ kind: 'css', value: cssPath }, '短 CSS 路径', KIND_SCORE.css);
  }

  return list.sort((a, b) => b.score - a.score);
}

/** 结构化 locator → 稳定字符串（去重 / 展示用） */
export function locatorKey(spec) {
  if (!spec || typeof spec !== 'object') return '';
  const parts = [spec.kind];
  if (spec.role) parts.push(spec.role);
  if (spec.name != null) parts.push(`name=${spec.name}`, spec.exact ? 'exact' : 'loose');
  if (spec.value != null) parts.push(`value=${spec.value}`, spec.exact ? 'exact' : 'loose');
  if (spec.attr) parts.push(`${spec.attr}=${spec.value}`);
  if (spec.nth != null) parts.push(`nth=${spec.nth}`);
  return parts.join('|');
}

/** 结构化 locator → Playwright Locator（Node 侧） */
export function buildLocator(page, spec) {
  if (!spec || !spec.kind) throw new Error('定位器缺少 kind');
  if (spec.kind === 'testid') return page.getByTestId(spec.value);
  if (spec.kind === 'role') {
    const options = {};
    if (spec.name != null && spec.name !== '') {
      options.name = spec.name;
      options.exact = Boolean(spec.exact);
    }
    return page.getByRole(spec.role, options);
  }
  if (spec.kind === 'label') return page.getByLabel(spec.value, { exact: Boolean(spec.exact) });
  if (spec.kind === 'placeholder') {
    return page.getByPlaceholder(spec.value, { exact: Boolean(spec.exact) });
  }
  if (spec.kind === 'text') return page.getByText(spec.value, { exact: Boolean(spec.exact) });
  if (spec.kind === 'attr') {
    const value = String(spec.value ?? '')
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"');
    return page.locator(`[${spec.attr}="${value}"]`);
  }
  if (spec.kind === 'css') return page.locator(spec.value);
  throw new Error(`不支持的定位器类型：${spec.kind}`);
}

/** 长 CSS / 多层 nth-of-type 换一次渲染就可能失效，不能当 high confidence */
export function isFragileLocator(spec) {
  if (!spec) return false;
  if (spec.kind !== 'css') return false;
  const value = String(spec.value ?? '');
  const nth = (value.match(/nth-of-type/g) || []).length;
  const segments = value.split('>').length;
  return nth >= 2 || segments >= 4;
}

/**
 * 逐个校验候选。
 * @param {import('playwright').Page} page
 * @param {import('playwright').ElementHandle} element 目标元素（ref 解出来的）
 * @param {{locator: Record<string, unknown>, source: string, score: number}[]} candidates
 */
export async function verifyCandidates(page, element, candidates) {
  const results = [];
  for (const candidate of candidates) {
    let count = 0;
    let same = false;
    let error = '';
    try {
      const locator = buildLocator(page, candidate.locator);
      count = await locator.count();
      if (count > 0) {
        same = await locator.evaluateAll((nodes, target) => nodes.includes(target), element);
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const unique = count === 1;
    results.push({
      locator: candidate.locator,
      source: candidate.source,
      count,
      unique,
      same,
      error,
      score: candidate.score,
    });

    // 同一元素在页面上有多个同名按钮时（列表行操作），用 nth 收窄：
    // 这就是 Playwright codegen 的 `.first()` / `.nth(2)`，比长 CSS 稳定得多。
    if (same && count > 1 && count <= 50) {
      let index = -1;
      try {
        const locator = buildLocator(page, candidate.locator);
        index = await locator.evaluateAll((nodes, target) => nodes.indexOf(target), element);
      } catch {
        index = -1;
      }
      if (index >= 0) {
        results.push({
          locator: { ...candidate.locator, nth: index },
          source: `${candidate.source} · 第 ${index + 1} 个`,
          count,
          unique: true,
          same: true,
          error: '',
          score: candidate.score - 25,
        });
      }
    }
  }

  // 先按「唯一 + 指向同一元素」排，再按权重
  results.sort((a, b) => {
    const rank = (item) => (item.same && item.unique ? 2 : item.same ? 1 : 0);
    if (rank(a) !== rank(b)) return rank(b) - rank(a);
    return b.score - a.score;
  });

  const best = results.find((item) => item.same && item.unique) ?? null;
  const fragile = best ? isFragileLocator(best.locator) : false;
  const ordered = best?.locator?.nth != null;

  return {
    candidates: results,
    recommended: best ? best.locator : null,
    confidence: !best
      ? results.some((item) => item.same)
        ? 'medium'
        : 'low'
      : fragile
        ? 'low'
        : ordered
          ? 'medium'
          : 'high',
    fragile: fragile || ordered,
    warning: fragile
      ? '只能靠长 CSS 定位（多层 nth-of-type），页面结构一变就失效；建议给元素加 data-testid'
      : ordered
        ? '同名元素有多个，靠页面顺序取第 N 个；列表顺序变动会失效'
        : '',
  };
}

/**
 * 探测一个 ref 可用的定位器。
 * @param {import('playwright').Page} page
 * @param {{ describeElement: Function }} helpers
 * @param {string} ref
 */
export async function probeLocators(page, helpers, ref) {
  const handle = await page.evaluateHandle((key) => {
    const store = window.__lanternRefs;
    return store ? (store.get(key) ?? null) : null;
  }, ref);
  const element = handle.asElement();
  if (!element) {
    await handle.dispose().catch(() => undefined);
    throw new Error(`ref ${ref} 已失效（元素不在页面上），请重新获取快照`);
  }
  try {
    const info = await helpers.describeElement(page, element);
    const candidates = buildCandidateLocators(info);
    const verified = await verifyCandidates(page, element, candidates);
    return {
      ref,
      element: info,
      ...verified,
    };
  } finally {
    await element.dispose().catch(() => undefined);
  }
}

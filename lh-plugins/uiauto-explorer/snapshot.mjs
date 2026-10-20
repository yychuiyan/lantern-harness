/**
 * 页面快照：把当前页面压成一棵「能点 / 能填」的精简树，每个节点带临时 ref。
 *
 * 设计对齐 Playwright MCP：用无障碍语义而不是截图，LLM 只认 ref。
 * 区别在于 ref 存在页面里（Map + 元素上的 expando），并允许旧 ref 在元素
 * 仍然存活时继续使用——比「快照即失效」宽容，少一次无谓的重新快照。
 *
 * ref 只是探索期的临时句柄，不能写进脚本；落盘前必须用 locators.mjs 转成
 * getByRole / getByLabel 这类可导出的定位器。
 */

/** 元素上记 ref 的属性名（只在页面内存里，不进 DOM 序列化） */
const REF_PROP = '__lanternRef';

/**
 * 注意：这个函数会被 `page.evaluate` 序列化到页面里执行，
 * 不能引用模块作用域的任何变量。
 */
export function snapshotInPage(options) {
  const opts = options || {};
  const maxNodes = Number(opts.maxNodes) > 0 ? Number(opts.maxNodes) : 400;
  const maxText = Number(opts.maxText) > 0 ? Number(opts.maxText) : 80;
  const maxDepth = Number(opts.maxDepth) > 0 ? Number(opts.maxDepth) : 12;
  const includeBoxes = Boolean(opts.includeBoxes);
  const targetRef = opts.targetRef || '';

  const refStore = window.__lanternRefs || (window.__lanternRefs = new Map());
  let seq = Number(window.__lanternRefSeq) || 0;
  // 每次导航后文档编号会变，旧 ref 不会恰好指向新页面里的同名序号
  const prefix = window.__lanternRefPrefix || '';

  // 清掉已经离开文档的旧 ref，避免 Map 无限长
  for (const [key, element] of refStore) {
    if (!element || !element.isConnected) refStore.delete(key);
  }

  const refOf = (element) => {
    // 不能引用模块作用域常量：这个函数会被序列化到页面里执行
    if (element.__lanternRef) return element.__lanternRef;
    seq += 1;
    const ref = `${prefix}e${seq}`;
    element.__lanternRef = ref;
    refStore.set(ref, element);
    return ref;
  };

  const clean = (value) =>
    String(value == null ? '' : value)
      .replace(/\s+/g, ' ')
      .trim();

  const clip = (value) => {
    const text = clean(value);
    return text.length > maxText ? `${text.slice(0, maxText)}…` : text;
  };

  const escapeAttr = (value) => String(value).replace(/"/g, '\\"');

  const roleOf = (element) => {
    const explicit = element.getAttribute('role');
    if (explicit) return explicit.split(/\s+/)[0];
    const tag = element.tagName.toLowerCase();
    if (tag === 'input') {
      const type = (element.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      if (type === 'number') return 'spinbutton';
      if (type === 'search') return 'searchbox';
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image')
        return 'button';
      if (type === 'file') return 'button';
      if (type === 'hidden') return '';
      return 'textbox';
    }
    if (tag === 'select') return element.multiple ? 'listbox' : 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'a') return element.hasAttribute('href') ? 'link' : '';
    if (tag === 'img') return 'img';
    if (tag === 'button') return 'button';
    if (tag === 'summary') return 'button';
    if (tag === 'li') return 'listitem';
    if (tag === 'ul' || tag === 'ol') return 'list';
    if (tag === 'table') return 'table';
    if (tag === 'tr') return 'row';
    if (tag === 'td') return 'cell';
    if (tag === 'th') return 'columnheader';
    if (tag === 'nav') return 'navigation';
    if (tag === 'main') return 'main';
    if (tag === 'header') return 'banner';
    if (tag === 'footer') return 'contentinfo';
    if (tag === 'form') return 'form';
    if (tag === 'dialog') return 'dialog';
    if (tag === 'section') return 'region';
    if (tag === 'article') return 'article';
    if (tag === 'aside') return 'complementary';
    if (tag === 'p') return 'paragraph';
    return '';
  };

  const INTERACTIVE = new Set([
    'button',
    'link',
    'textbox',
    'searchbox',
    'combobox',
    'listbox',
    'checkbox',
    'radio',
    'switch',
    'slider',
    'spinbutton',
    'menuitem',
    'tab',
    'option',
    'treeitem',
  ]);
  const STRUCTURAL = new Set([
    'heading',
    'main',
    'navigation',
    'banner',
    'contentinfo',
    'form',
    'dialog',
    'region',
    'list',
    'table',
    'article',
  ]);

  const accessibleName = (element) => {
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .map((node) => clean(node.textContent))
        .join(' ');
      if (text) return clip(text);
    }
    const ariaLabel = element.getAttribute('aria-label');
    if (ariaLabel) return clip(ariaLabel);
    if (element.id) {
      const label = document.querySelector(`label[for="${escapeAttr(element.id)}"]`);
      if (label) {
        const text = clip(label.textContent);
        if (text) return text;
      }
    }
    const wrapper = element.closest('label');
    if (wrapper && wrapper !== element) {
      const text = clip(wrapper.textContent);
      if (text) return text;
    }
    const placeholder = element.getAttribute('placeholder');
    if (placeholder) return clip(placeholder);
    const alt = element.getAttribute('alt');
    if (alt) return clip(alt);
    if (element.tagName === 'INPUT') {
      const type = (element.getAttribute('type') || 'text').toLowerCase();
      if (type === 'submit' || type === 'button' || type === 'reset') return clip(element.value);
      return '';
    }
    if (element.tagName === 'SELECT' || element.tagName === 'TEXTAREA') return '';
    const text = clip(element.textContent);
    if (text) return text;
    // 图标按钮：Ant Design 等把语义放在子节点的 aria-label / use#icon-* 上
    const icon = element.querySelector('[aria-label]');
    if (icon) {
      const label = clip(icon.getAttribute('aria-label'));
      if (label) return label;
    }
    const use = element.querySelector('use');
    if (use) {
      const href = use.getAttribute('href') || use.getAttribute('xlink:href') || '';
      if (href) return clip(href.replace(/^#/, '').replace(/^icon-/, ''));
    }
    const svgTitle = element.querySelector('svg title');
    if (svgTitle) {
      const label = clip(svgTitle.textContent);
      if (label) return label;
    }
    return clip(element.getAttribute('title'));
  };

  const isVisible = (element) => {
    if (
      element.tagName === 'INPUT' &&
      (element.getAttribute('type') || '').toLowerCase() === 'hidden'
    )
      return false;
    const rect = element.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    const style = getComputedStyle(element);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    if (Number(style.opacity) === 0) return false;
    if (element.getAttribute('aria-hidden') === 'true') return false;
    return true;
  };

  const extraStates = (element, role) => {
    const parts = [];
    if (element.disabled || element.getAttribute('aria-disabled') === 'true')
      parts.push('disabled');
    if (role === 'checkbox' || role === 'radio' || role === 'switch') {
      const checked =
        'checked' in element ? Boolean(element.checked) : element.getAttribute('aria-checked');
      if (checked === true || checked === 'true') parts.push('checked');
    }
    if (role === 'tab' || role === 'option') {
      if (element.getAttribute('aria-selected') === 'true') parts.push('selected');
    }
    if (role === 'button' && element.getAttribute('aria-expanded')) {
      parts.push(`expanded=${element.getAttribute('aria-expanded')}`);
    }
    if ((role === 'textbox' || role === 'combobox' || role === 'searchbox') && element.value) {
      if ((element.getAttribute('type') || '').toLowerCase() !== 'password') {
        parts.push(`value="${clip(element.value)}"`);
      }
    }
    if (role === 'heading' && /^h[1-6]$/i.test(element.tagName)) {
      parts.push(`level=${element.tagName.slice(1)}`);
    }
    const testId =
      element.getAttribute('data-testid') ||
      element.getAttribute('data-test-id') ||
      element.getAttribute('data-test');
    if (testId) parts.push(`testid=${testId}`);
    if (element.getAttribute('title')) parts.push(`title="${clip(element.getAttribute('title'))}"`);
    if (includeBoxes) {
      const rect = element.getBoundingClientRect();
      parts.push(
        `box=${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)},${Math.round(
          rect.height,
        )}`,
      );
    }
    return parts.length ? ` [${parts.join(' ')}]` : '';
  };

  const root = targetRef ? refStore.get(targetRef) : document.body;
  if (!root) {
    return { text: '', count: 0, url: location.href, title: document.title, missing: targetRef };
  }

  const lines = [];
  const items = [];
  let count = 0;
  let textCount = 0;
  let truncated = false;
  const maxTextNodes = 150;

  // depth 按「语义层级」算（只数被收录的节点），和 Playwright 的 a11y 树一致；
  // domDepth 只用来防病态嵌套，不参与截断，否则真实页面里的输入框会被埋掉。
  const walk = (element, domDepth, level) => {
    if (!element || count >= maxNodes || level > maxDepth || domDepth > 80) {
      if (count >= maxNodes) truncated = true;
      return;
    }
    const tag = element.tagName ? element.tagName.toLowerCase() : '';
    if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template') return;

    const role = roleOf(element);
    const interactive = INTERACTIVE.has(role) || element.hasAttribute('onclick');
    const structural = STRUCTURAL.has(role);
    const visible = isVisible(element);
    let nextLevel = level;

    if (visible && (interactive || structural)) {
      const name = accessibleName(element);
      const indent = '  '.repeat(Math.min(level, 10));
      const ref = interactive ? refOf(element) : '';
      const state = extraStates(element, role);
      const label = name ? ` "${name}"` : '';
      const refPart = ref ? ` [ref=${ref}]` : '';
      lines.push(`- ${indent}${role}${label}${state}${refPart}`);
      count += 1;
      items.push({ ref, role, name, tag, interactive, index: count });
      nextLevel = level + 1;
    } else if (
      visible &&
      !role &&
      element.children.length === 0 &&
      textCount < maxTextNodes &&
      !element.closest('button, a, label, option, h1, h2, h3, h4, h5, h6, script, style')
    ) {
      // 纯文本节点：断言要看的结果（提示语、表格内容、状态文案）都在这里
      const text = clip(element.textContent);
      if (text) {
        const ref = refOf(element);
        lines.push(`- ${'  '.repeat(Math.min(level, 10))}text: ${text} [ref=${ref}]`);
        textCount += 1;
        items.push({ ref, role: 'text', name: text, tag, interactive: false, index: count });
      }
    }

    const children = [];
    for (const child of element.children) children.push(child);
    if (element.shadowRoot) {
      for (const child of element.shadowRoot.children) children.push(child);
    }
    for (const child of children) walk(child, domDepth + 1, nextLevel);
  };

  walk(root, 0, 0);
  window.__lanternRefSeq = seq;

  return {
    text: lines.join('\n'),
    count,
    truncated,
    url: location.href,
    title: document.title,
    items,
  };
}

/** 页面内取元素的定位信息（给 locators.mjs 拼候选定位器用） */
export function describeElementInPage(element) {
  const clean = (value) =>
    String(value == null ? '' : value)
      .replace(/\s+/g, ' ')
      .trim();
  const escapeAttr = (value) => String(value).replace(/"/g, '\\"');
  const stableId = (value) => {
    const id = clean(value);
    if (!id) return '';
    if (/^\d/.test(id)) return '';
    // 纯数字 / uuid / 哈希这类生成 id 换一次渲染就变，不能当契约
    if (/^(?:[0-9a-f]{8,}|[a-z]*-?\d{5,})$/i.test(id)) return '';
    if (/[0-9a-f]{8,}-[0-9a-f]{4}/i.test(id)) return '';
    return id;
  };
  const role = (() => {
    const explicit = element.getAttribute('role');
    if (explicit) return explicit.split(/\s+/)[0];
    const tag = element.tagName.toLowerCase();
    if (tag === 'input') {
      const type = (element.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      if (type === 'number') return 'spinbutton';
      if (type === 'search') return 'searchbox';
      if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
      if (type === 'file') return 'button';
      return 'textbox';
    }
    if (tag === 'select') return element.multiple ? 'listbox' : 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'a') return element.hasAttribute('href') ? 'link' : '';
    if (tag === 'button') return 'button';
    if (tag === 'summary') return 'button';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'img') return 'img';
    return '';
  })();

  const name = (() => {
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .map((node) => clean(node.textContent))
        .join(' ');
      if (text) return clean(text);
    }
    const ariaLabel = element.getAttribute('aria-label');
    if (ariaLabel) return clean(ariaLabel);
    if (element.id) {
      const label = document.querySelector(`label[for="${escapeAttr(element.id)}"]`);
      if (label) {
        const text = clean(label.textContent);
        if (text) return text;
      }
    }
    const wrapper = element.closest('label');
    if (wrapper && wrapper !== element) {
      const text = clean(wrapper.textContent);
      if (text) return text;
    }
    const placeholder = element.getAttribute('placeholder');
    if (placeholder) return clean(placeholder);
    const alt = element.getAttribute('alt');
    if (alt) return clean(alt);
    if (element.tagName === 'INPUT') {
      const type = (element.getAttribute('type') || 'text').toLowerCase();
      if (type === 'submit' || type === 'button' || type === 'reset') return clean(element.value);
      return '';
    }
    if (element.tagName === 'SELECT' || element.tagName === 'TEXTAREA') return '';
    const text = clean(element.textContent);
    if (text && text.length <= 60) return text;
    const icon = element.querySelector('[aria-label]');
    if (icon) {
      const label = clean(icon.getAttribute('aria-label'));
      if (label) return label;
    }
    const use = element.querySelector('use');
    if (use) {
      const href = use.getAttribute('href') || use.getAttribute('xlink:href') || '';
      if (href) return clean(href.replace(/^#/, '').replace(/^icon-/, ''));
    }
    const svgTitle = element.querySelector('svg title');
    if (svgTitle) {
      const label = clean(svgTitle.textContent);
      if (label) return label;
    }
    return clean(element.getAttribute('title'));
  })();

  const labelText = (() => {
    if (element.id) {
      const label = document.querySelector(`label[for="${escapeAttr(element.id)}"]`);
      if (label) return clean(label.textContent);
    }
    const wrapper = element.closest('label');
    if (wrapper && wrapper !== element) return clean(wrapper.textContent);
    return '';
  })();

  const cssPath = (() => {
    const parts = [];
    let node = element;
    for (let i = 0; i < 5 && node && node.nodeType === 1; i += 1) {
      const tag = node.tagName.toLowerCase();
      const testId =
        node.getAttribute('data-testid') ||
        node.getAttribute('data-test-id') ||
        node.getAttribute('data-test');
      if (testId) {
        parts.unshift(`[data-testid="${escapeAttr(testId)}"]`);
        break;
      }
      const nameAttr = node.getAttribute('name');
      if (nameAttr) {
        parts.unshift(`${tag}[name="${escapeAttr(nameAttr)}"]`);
        break;
      }
      const id = stableId(node.id);
      if (id) {
        parts.unshift(`#${id}`);
        break;
      }
      const parent = node.parentElement;
      let part = tag;
      if (parent) {
        const siblings = Array.from(parent.children).filter(
          (child) => child.tagName === node.tagName,
        );
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ');
  })();

  return {
    tag: element.tagName.toLowerCase(),
    role,
    name,
    labelText,
    placeholder: clean(element.getAttribute('placeholder')),
    ariaLabel: clean(element.getAttribute('aria-label')),
    testId:
      clean(element.getAttribute('data-testid')) ||
      clean(element.getAttribute('data-test-id')) ||
      clean(element.getAttribute('data-test')),
    id: clean(element.id),
    nameAttr: clean(element.getAttribute('name')),
    href: clean(element.getAttribute('href')).slice(0, 120),
    text: clean(element.textContent).slice(0, 80),
    cssPath,
    hasAriaLabel: Boolean(element.getAttribute('aria-label')),
  };
}

/** 取页面快照（Node 侧入口） */
export async function takeSnapshot(page, options = {}) {
  return page.evaluate(snapshotInPage, options);
}

/** 取元素定位信息（Node 侧入口） */
export async function describeElement(page, handle) {
  return page.evaluate(describeElementInPage, handle);
}

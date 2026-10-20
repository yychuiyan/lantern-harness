/**
 * 写入已存在的文件时，默认「合并」而不是整文件覆盖。
 *
 * 起因：项目里原有 admin_cart.spec.ts 有几百行、好几个用例，新增一个用例
 * 直接把整文件覆盖等于把人家的用例全删了。所以按文件角色分别合并：
 * - spec：保留原文件，只把这次生成的用例追加进去（缺的 import 补到 import 区）
 * - page object：保类不动，只往类里补缺失的方法
 * - fixture：已经有 STORAGE_STATE 就不动，没有才追加
 *
 * 合并真正做不了（比如类名/文件名对不上、语法结构认不出来）时返回 null，
 * 上层按「冲突」处理，让用户显式勾选覆盖。
 *
 * 全部函数都是纯字符串处理，方便单测。
 */

const TS_IMPORT = /^import\s/;
const PY_IMPORT = /^(?:import\s|from\s+\S+\s+import\s)/;

function isImportLine(line, lang) {
  if (!line || /^\s/.test(line)) return false;
  return lang === 'python' ? PY_IMPORT.test(line) : TS_IMPORT.test(line);
}

function escapeRe(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 找出 import 区的范围：返回 [第一行 import 下标, 最后一行 import 下标] */
function importRange(lines, lang) {
  let first = -1;
  let last = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (!isImportLine(lines[index], lang)) continue;
    if (first === -1) first = index;
    last = index;
  }
  return [first, last];
}

/** 把缺的 import 补到已有文件里：有 import 就接在最后一个后面，没有就放最前面 */
function insertImports(existing, imports, lang) {
  if (!imports.length) return existing;
  const lines = existing.split('\n');
  const [, lastIndex] = importRange(lines, lang);
  if (lastIndex === -1) return [...imports, '', ...lines].join('\n');
  const head = lines.slice(0, lastIndex + 1);
  const tail = lines.slice(lastIndex + 1);
  // 后面紧跟着空行就保持一个空行，不额外再加
  if (tail.length && tail[0].trim() === '') return [...head, ...imports, ...tail].join('\n');
  return [...head, ...imports, '', ...tail].join('\n');
}

function guessLang(text, filePath) {
  if (/\.py$/i.test(filePath || '')) return 'python';
  if (/\.(ts|tsx|js|mjs|cjs|jsx)$/i.test(filePath || '')) return 'ts';
  return /^\s*(?:from|import)\s+\S+\s*$/m.test(text) || /\bdef\s+\w+\(/.test(text)
    ? 'python'
    : 'ts';
}

/** spec 的「用例签名」：用来判断这个用例是不是已经写过了 */
function specSignature(text, lang) {
  if (lang === 'python') {
    const hit = /^def\s+(test_\w+)\(/m.exec(text);
    return hit ? `def ${hit[1]}(` : '';
  }
  const hit = /^\s*test\("([^"]+)"/m.exec(text);
  return hit ? `test("${hit[1]}"` : '';
}

/**
 * spec 合并：补 import + 追加用例块。
 * 用例已经存在（同名 test / 同名 test_ 函数）就原样返回，避免重复跑。
 */
export function mergeSpec(existing, incoming, lang) {
  const incLines = incoming.split('\n');
  const [, incLastImport] = importRange(incLines, lang);
  const existingLines = existing.split('\n');
  const existingSet = new Set(existingLines.map((line) => line.trim()));

  const missing = [];
  for (let index = 0; index <= incLastImport; index += 1) {
    const line = incLines[index];
    if (!isImportLine(line, lang)) continue;
    const trimmed = line.trim();
    if (!existingSet.has(trimmed)) missing.push(trimmed);
  }

  const sig = specSignature(incoming, lang);
  if (sig && existing.includes(sig)) {
    return { content: existing, unchanged: true };
  }

  // 用例正文 = 最后一个 import 之后的内容（顺带丢掉文件头的说明注释）
  const bodyLines = [];
  const topLevel = [];
  for (const line of incLines.slice(incLastImport + 1)) {
    const trimmed = line.trim();
    // test.use / BASE_URL 这类文件级语句：已有就别重复，缺的提到 import 后面
    if (/^test\.use\(/.test(trimmed) || /^BASE_URL\s*=/.test(trimmed)) {
      if (!existingSet.has(trimmed)) topLevel.push(trimmed);
      continue;
    }
    bodyLines.push(line);
  }
  const body = bodyLines.join('\n').trim();
  if (!body && !topLevel.length) return { content: existing, unchanged: true };

  const block = topLevel.length ? [...missing, '', ...topLevel] : missing;
  const withImports = insertImports(existing, block, lang);
  const content = body
    ? `${withImports.replace(/\s+$/, '')}\n\n${body}\n`
    : `${withImports.replace(/\s+$/, '')}\n`;
  return { content, unchanged: false };
}

/** TS page object 里的方法块（2 空格缩进，按大括号配平取方法体） */
function tsMethods(text) {
  const lines = text.split('\n');
  const out = [];
  for (let index = 0; index < lines.length; index += 1) {
    const start = /^ {2}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/.exec(lines[index]);
    if (!start) continue;
    let depth = 0;
    let opened = false;
    let end = index;
    for (let cursor = index; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      for (const char of line) {
        if (char === '{') {
          depth += 1;
          opened = true;
        } else if (char === '}') {
          depth -= 1;
        }
      }
      end = cursor;
      if (opened && depth <= 0) break;
    }
    out.push({ name: start[1], code: lines.slice(index, end + 1).join('\n') });
    index = end;
  }
  return out;
}

/** Python page object 里的方法块（4 空格缩进，到下一个同级语句为止） */
function pyMethods(text) {
  const lines = text.split('\n');
  const out = [];
  for (let index = 0; index < lines.length; index += 1) {
    const start = /^ {4}def\s+(\w+)\s*\(/.exec(lines[index]);
    if (!start) continue;
    let end = lines.length - 1;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (/^ {0,4}\S/.test(lines[cursor])) {
        end = cursor - 1;
        break;
      }
    }
    while (end > index && lines[end].trim() === '') end -= 1;
    out.push({ name: start[1], code: lines.slice(index, end + 1).join('\n') });
    index = end;
  }
  return out;
}

/** TS page object 合并：类名一致时只补缺失的方法，插在类结尾 } 之前 */
export function mergeTsPage(existing, incoming) {
  const cls = /export\s+class\s+(\w+)/.exec(incoming)?.[1];
  if (!cls) return null;
  if (!new RegExp(`export\\s+class\\s+${escapeRe(cls)}\\b`).test(existing)) return null;

  const missing = tsMethods(incoming).filter(
    (method) =>
      method.name !== 'constructor' &&
      !new RegExp(`(?:async\\s+)?${escapeRe(method.name)}\\s*\\(`).test(existing),
  );
  if (!missing.length) return { content: existing, unchanged: true };

  const closeAt = existing.lastIndexOf('\n}');
  if (closeAt === -1) return null;
  // 每个方法前留一个空行，和生成器保持一致
  const blocks = missing.map((method) => `\n\n${method.code}`);
  const content = `${existing.slice(0, closeAt)}${blocks.join('')}\n${existing
    .slice(closeAt)
    .replace(/^\n/, '')}`;
  return { content, unchanged: false };
}

/** Python page object 合并：类名一致时把缺失的方法追加到文件末尾（类在文件最后） */
export function mergePyPage(existing, incoming) {
  const cls = /^class\s+(\w+)/m.exec(incoming)?.[1];
  if (!cls) return null;
  if (!new RegExp(`^class\\s+${escapeRe(cls)}\\b`, 'm').test(existing)) return null;

  const missing = pyMethods(incoming).filter(
    (method) =>
      method.name !== '__init__' &&
      !new RegExp(`def\\s+${escapeRe(method.name)}\\s*\\(`).test(existing),
  );
  if (!missing.length) return { content: existing, unchanged: true };

  const content = `${existing.replace(/\s+$/, '')}\n\n${missing
    .map((method) => method.code)
    .join('\n\n')}\n`;
  return { content, unchanged: false };
}

/** 登录态常量：已经有 STORAGE_STATE 就完全不动 */
export function mergeFixture(existing, incoming) {
  if (/STORAGE_STATE/.test(existing)) return { content: existing, unchanged: true };
  const body = incoming.trim();
  if (!body) return { content: existing, unchanged: true };
  return { content: `${existing.replace(/\s+$/, '')}\n\n${body}\n`, unchanged: false };
}

/**
 * 入口：按角色合并。返回 `{ content, unchanged }`；无法安全合并返回 null。
 */
export function mergeGeneratedFile(existing, incoming, options = {}) {
  const role = String(options.role || '');
  const filePath = String(options.path || '');
  const before = String(existing ?? '');
  const after = String(incoming ?? '');
  if (!after.trim()) return { content: before, unchanged: true };
  if (!before.trim()) return { content: after, unchanged: false };
  if (before.trim() === after.trim()) return { content: before, unchanged: true };

  const lang = guessLang(after, filePath);
  if (role === 'spec') return mergeSpec(before, after, lang);
  if (role === 'page')
    return lang === 'python' ? mergePyPage(before, after) : mergeTsPage(before, after);
  if (role === 'fixture') return mergeFixture(before, after);
  return null;
}

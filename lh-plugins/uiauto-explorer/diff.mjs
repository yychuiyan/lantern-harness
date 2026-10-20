/**
 * 极简行级 diff：给「文件变更」面板用，不引第三方依赖。
 *
 * 做法：先剥掉公共前后缀，再对中间段做 LCS；段太大时退化成整块替换，
 * 宁可粗一点也不要卡住浏览器（AI 生成的 spec 一般几十行，退化很少发生）。
 */

const MAX_LINES = 4000;
const MAX_CELLS = 4_000_000;

function toLines(text) {
  const value = String(text ?? '');
  if (!value) return [];
  const lines = value.split(/\r?\n/);
  // 末尾换行不单独算一行，否则每个文件都会多出一条空上下文
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** 中间段 LCS → 操作序列 */
function diffMiddle(a, b) {
  if (!a.length) return b.map((text) => ({ type: 'add', text }));
  if (!b.length) return a.map((text) => ({ type: 'del', text }));
  if (a.length * b.length > MAX_CELLS) {
    return [
      ...a.map((text) => ({ type: 'del', text })),
      ...b.map((text) => ({ type: 'add', text })),
    ];
  }
  const rows = a.length;
  const cols = b.length;
  // 从后往前填表，回溯时正好从前往后走
  const table = new Uint32Array((rows + 1) * (cols + 1));
  const at = (i, j) => i * (cols + 1) + j;
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      table[at(i, j)] =
        a[i] === b[j]
          ? table[at(i + 1, j + 1)] + 1
          : Math.max(table[at(i + 1, j)], table[at(i, j + 1)]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (a[i] === b[j]) {
      ops.push({ type: 'equal', text: a[i] });
      i += 1;
      j += 1;
    } else if (table[at(i + 1, j)] >= table[at(i, j + 1)]) {
      ops.push({ type: 'del', text: a[i] });
      i += 1;
    } else {
      ops.push({ type: 'add', text: b[j] });
      j += 1;
    }
  }
  while (i < rows) {
    ops.push({ type: 'del', text: a[i] });
    i += 1;
  }
  while (j < cols) {
    ops.push({ type: 'add', text: b[j] });
    j += 1;
  }
  return ops;
}

function diffOps(a, b) {
  const maxPrefix = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < maxPrefix && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < maxPrefix - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) {
    suffix += 1;
  }
  const head = a.slice(0, prefix).map((text) => ({ type: 'equal', text }));
  const middleA = a.slice(prefix, a.length - suffix);
  const middleB = b.slice(prefix, b.length - suffix);
  const tail = suffix ? a.slice(a.length - suffix).map((text) => ({ type: 'equal', text })) : [];
  return [...head, ...diffMiddle(middleA, middleB), ...tail];
}

/**
 * @param {string} before 旧内容（新文件传空串）
 * @param {string} after 新内容
 * @param {{ context?: number, maxLines?: number }} [options]
 */
export function diffText(before, after, options = {}) {
  const context = Math.max(0, Math.min(20, Number(options.context ?? 3)));
  const maxLines = Math.max(100, Number(options.maxLines ?? MAX_LINES));
  const a = toLines(before);
  const b = toLines(after);

  if (a.length + b.length > maxLines) {
    return {
      hunks: [],
      added: b.length,
      removed: a.length,
      truncated: true,
      message: `文件较大（${a.length + b.length} 行），只显示增删行数`,
    };
  }

  const ops = diffOps(a, b);
  const added = ops.filter((op) => op.type === 'add').length;
  const removed = ops.filter((op) => op.type === 'del').length;

  // 只保留「有改动」的行及其上下文，拼成 hunk
  const keep = new Array(ops.length).fill(false);
  ops.forEach((op, index) => {
    if (op.type === 'equal') return;
    for (let k = index - context; k <= index + context; k += 1) {
      if (k >= 0 && k < ops.length) keep[k] = true;
    }
  });

  const hunks = [];
  let index = 0;
  // 行号按「改动前的旧文件 / 改动后的新文件」分别累加
  let oldNo = 1;
  let newNo = 1;
  while (index < ops.length) {
    if (!keep[index]) {
      if (ops[index].type !== 'add') oldNo += 1;
      if (ops[index].type !== 'del') newNo += 1;
      index += 1;
      continue;
    }
    const lines = [];
    const oldStart = oldNo;
    const newStart = newNo;
    let oldCount = 0;
    let newCount = 0;
    while (index < ops.length && keep[index]) {
      const op = ops[index];
      lines.push({ type: op.type, text: op.text });
      if (op.type !== 'add') {
        oldNo += 1;
        oldCount += 1;
      }
      if (op.type !== 'del') {
        newNo += 1;
        newCount += 1;
      }
      index += 1;
    }
    hunks.push({ oldStart, oldLines: oldCount, newStart, newLines: newCount, lines });
  }

  return { hunks, added, removed, truncated: false };
}

/** 写进会话账本的一行统计，不存整份内容 */
export function summarizeDiff(before, after) {
  const result = diffText(before, after, { context: 0 });
  return { added: result.added, removed: result.removed };
}

/**
 * 用例表的字段别名：把各家模板的表头对到评审用的标准字段。
 *
 * 用例文件是用户自己定的模板（`测试项目`、`期望内容标准`、`预置条件` 这类表头很常见），
 * 评审与补全如果只认 `用例标题 / 测试步骤 / 预期结果`，就会把好好的用例判成「无标题、步骤为空」。
 * 这里做两件事：
 * - 读：把标准字段名补到行上（原始表头仍然保留，表格按文件原样展示）；
 * - 写：写回文件时把标准字段的值搬到文件自己的表头上，不新增列。
 */

export type CaseFieldKey =
  | 'no'
  | 'title'
  | 'precondition'
  | 'steps'
  | 'expected'
  | 'priority'
  | 'type'
  | 'module'
  | 'requirement';

/** 标准字段名（行数据里统一用这些 key） */
export const CASE_FIELD_NAME: Record<CaseFieldKey, string> = {
  no: '用例编号',
  title: '用例标题',
  precondition: '前置条件',
  steps: '测试步骤',
  expected: '预期结果',
  priority: '优先级',
  type: '用例类型',
  module: '所属模块',
  requirement: '需求编号',
};

/** 标准字段名的字面量联合（行数据里补进来的那几个 key） */
export type CaseFieldName = (typeof CASE_FIELD_NAME)[CaseFieldKey];

/**
 * 表头别名：按优先级排列，靠前的先匹配。
 * 只放「语义明确」的名字——`结果`、`类型` 这种太泛的放在最后，避免抢到别的列。
 */
const ALIASES: Record<CaseFieldKey, string[]> = {
  no: [
    '用例编号',
    '测试用例编号',
    '案例编号',
    '用例号',
    '用例id',
    '编号',
    'no',
    'caseid',
    'tc编号',
  ],
  title: [
    '用例标题',
    '用例名称',
    '测试用例标题',
    // 有些模板分两级：`测试项目` 放迭代 / 模块名，`测试分项目` 才是这一条用例的标题。
    // `测试分项目` 排在 `测试项目` 前面，这类文件才不会被整列同名标题盖住。
    '测试分项目',
    '测试项目',
    '测试点',
    '检查点',
    '测试内容',
    '用例描述',
    '用例说明',
    '标题',
    '名称',
    '摘要',
    'title',
    'casename',
  ],
  precondition: [
    '前置条件',
    '预置条件',
    '前提条件',
    '准备条件',
    '初始条件',
    '前置',
    'precondition',
  ],
  steps: [
    '测试步骤',
    '操作步骤',
    '执行步骤',
    '用例步骤',
    '测试过程',
    '操作过程',
    '步骤',
    'steps',
    'step',
  ],
  expected: [
    '预期结果',
    '期望结果',
    '预期内容',
    '期望内容标准',
    '预期效果',
    '期望结果标准',
    '验收标准',
    '检查结果',
    '预期',
    'expected',
  ],
  priority: ['优先级', '优先级别', '重要级别', '重要程度', '级别', 'priority'],
  type: ['用例类型', '测试类型', '用例种类', '类型', '类别', 'type'],
  module: [
    '所属模块',
    '测试模块',
    '功能模块',
    '所属功能',
    '所属子系统',
    '模块',
    '测试项目',
    'module',
  ],
  requirement: ['需求编号', '关联需求', '需求id', '需求', 'requirement'],
};

/** 表头归一化：去空白 / 星号 / 括号注释，转小写 */
function normalizeHeader(raw: string): string {
  return String(raw ?? '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[\s*＊・·:：]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * 建字段映射：标准字段 → 文件里实际的表头。
 * 先精确匹配，再允许「表头比别名多几个字」（如 `测试步骤说明`）；差太多就不认，宁可不映射。
 */
export function caseFieldMap(headers: readonly string[]): Partial<Record<CaseFieldKey, string>> {
  const pairs = headers
    .map((h) => ({ raw: String(h ?? ''), norm: normalizeHeader(h) }))
    .filter((p) => p.norm && p.raw);
  const map: Partial<Record<CaseFieldKey, string>> = {};
  const used = new Set<string>();
  const fields = Object.keys(ALIASES) as CaseFieldKey[];

  // 先按别名优先级精确匹配：同一份文件同时有「用例标题」和「测试项目」时，优先认前者
  for (const field of fields) {
    for (const alias of ALIASES[field].map(normalizeHeader)) {
      const hit = pairs.find((p) => !used.has(p.raw) && p.norm === alias);
      if (!hit) continue;
      map[field] = hit.raw;
      used.add(hit.raw);
      break;
    }
  }
  // 再允许「表头比别名多几个字」（如 `测试步骤说明`）；差太多不认，宁可不映射
  for (const field of fields) {
    if (map[field]) continue;
    for (const alias of ALIASES[field].map(normalizeHeader)) {
      if (alias.length < 3) continue;
      const hit = pairs.find(
        (p) =>
          !used.has(p.raw) &&
          Math.abs(p.norm.length - alias.length) <= 2 &&
          (p.norm.startsWith(alias) || alias.startsWith(p.norm)),
      );
      if (!hit) continue;
      map[field] = hit.raw;
      used.add(hit.raw);
      break;
    }
  }
  return map;
}

/** 行上的表头集合（按出现顺序去重） */
function headersOf(rows: readonly Record<string, string>[]): string[] {
  const out: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) if (!out.includes(key)) out.push(key);
  }
  return out;
}

/**
 * 把标准字段补到行上：标准 key 为空时，用映射到的实际表头取值。
 * 原始表头不动，表格仍按文件原样展示；映射到的列即使是空值也补上 key，
 * 这样「字段完整率」能按文件真实的列来算，而不是把没有的列也算成缺失。
 */
export function canonicalizeRows<T extends Record<string, string>>(
  rows: readonly T[],
): Array<T & Partial<Record<CaseFieldName, string>>> {
  if (!rows.length) return [...rows];
  const map = caseFieldMap(headersOf(rows));
  return rows.map((row) => {
    const next: Record<string, string> = { ...row };
    for (const field of Object.keys(CASE_FIELD_NAME) as CaseFieldKey[]) {
      const actual = map[field];
      if (!actual) continue;
      if (!String(next[CASE_FIELD_NAME[field]] ?? '').trim()) {
        next[CASE_FIELD_NAME[field]] = next[actual] ?? '';
      }
    }
    return next as T;
  });
}

/**
 * 写回前把标准字段的值搬到文件自己的表头列上。
 * 追加行只填标准 key（用例标题 / 测试步骤…），不搬的话写进文件会是一排空单元格。
 */
export function applyFieldMap<T extends Record<string, string>>(
  row: T,
  map: Partial<Record<CaseFieldKey, string>>,
): T {
  const next: Record<string, string> = { ...row };
  for (const field of Object.keys(CASE_FIELD_NAME) as CaseFieldKey[]) {
    const actual = map[field];
    if (!actual || actual === CASE_FIELD_NAME[field]) continue;
    if (String(next[actual] ?? '').trim()) continue;
    const value = String(next[CASE_FIELD_NAME[field]] ?? '');
    if (value) next[actual] = value;
  }
  return next as T;
}

/** 字段对照的可读描述，用于提示词里告诉模型「哪个列才是标题 / 步骤」 */
export function describeFieldMap(map: Partial<Record<CaseFieldKey, string>>): string {
  const parts: string[] = [];
  for (const field of Object.keys(CASE_FIELD_NAME) as CaseFieldKey[]) {
    const actual = map[field];
    if (!actual) continue;
    const standard = CASE_FIELD_NAME[field];
    parts.push(actual === standard ? standard : `${standard}（表头：${actual}）`);
  }
  return parts.join(' / ');
}

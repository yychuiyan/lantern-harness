/** 技能输出的确定性校验；不调用模型、不执行用户代码。也可复制到技能包独立运行。 */
export function validateSkillOutput(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return { ok: false, errors: ['输入必须是对象'], warnings: [] };
  const errors = [],
    warnings = [];
  const rows = input.rows ?? input.用例 ?? input.items;
  if (!Array.isArray(rows))
    return { ok: false, errors: ['需要 rows / 用例 / items 数组'], warnings };
  const columns = Array.isArray(input.columns) ? input.columns : [];
  const known = new Set(input.sourceIds ?? []),
    ids = new Set();
  rows.forEach((row, index) => {
    const at = `第 ${index + 1} 项`;
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      errors.push(`${at}不是对象`);
      return;
    }
    if (columns.length) {
      const missing = columns.filter((key) => !(key in row));
      const extra = Object.keys(row).filter((key) => !columns.includes(key));
      if (missing.length) errors.push(`${at}缺少字段：${missing.join('、')}`);
      if (extra.length) errors.push(`${at}多出字段：${extra.join('、')}`);
    }
    const id = row.id ?? row['用例编号'] ?? row.code;
    if (id != null && String(id).trim()) {
      if (ids.has(String(id))) errors.push(`${at}编号重复：${id}`);
      ids.add(String(id));
    }
    const refs = row.sourceRefs ?? row.sourceIds ?? [];
    if (!Array.isArray(refs)) errors.push(`${at}来源引用必须是数组`);
    else if (known.size)
      for (const ref of refs) if (!known.has(ref)) errors.push(`${at}引用不存在：${ref}`);
    if (row.priority != null && !['P0', 'P1', 'P2', 'P3'].includes(row.priority))
      errors.push(`${at}优先级应为 P0–P3`);
    if (row.score != null && (!Number.isFinite(row.score) || row.score < 0 || row.score > 100))
      errors.push(`${at}分数应在 0–100`);
    for (const [key, allowed] of Object.entries(input.enums ?? {})) {
      if (key in row && Array.isArray(allowed) && !allowed.includes(row[key]))
        errors.push(`${at}${key}不在允许值内`);
    }
  });
  if (input.stats) {
    const { total, passed, failed, skipped = 0 } = input.stats;
    if (![total, passed, failed, skipped].every((x) => Number.isInteger(x) && x >= 0))
      errors.push('统计数量必须是非负整数');
    else if (passed + failed + skipped !== total) errors.push('通过、失败、跳过之和不等于总数');
  }

  if (Array.isArray(input.requiredSections)) {
    const sections = Array.isArray(input.sections) ? input.sections : [];
    for (const section of input.requiredSections)
      if (!sections.includes(section)) errors.push(`缺少章节：${section}`);
  }
  if (Array.isArray(input.metrics))
    for (const metric of input.metrics) {
      if (!metric || !Number.isFinite(metric.value) || metric.value < 0)
        errors.push('指标必须具有非负实测数值');
      if (!metric?.unit || typeof metric.unit !== 'string') errors.push('指标缺少单位');
      if (metric?.threshold == null)
        warnings.push(`指标 ${metric?.name || ''} 未提供阈值，不判断达标`);
    }
  if (Array.isArray(input.requiredFiles))
    for (const file of input.requiredFiles) {
      if (!Array.isArray(input.files) || !input.files.includes(file))
        errors.push(`缺少项目文件：${file}`);
    }
  if (!columns.length) warnings.push('未提供模板字段，未检查表头一致性');
  if (!known.size) warnings.push('未提供合法来源 ID，未检查引用有效性');
  if (!rows.length) warnings.push('输出为空，请检查输入材料和未覆盖说明');
  return { ok: errors.length === 0, errors, warnings, count: rows.length };
}

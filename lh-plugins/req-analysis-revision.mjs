import crypto from 'node:crypto';

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (key === 'updatedAt' || key === 'revision') continue;
    out[key] = stableValue(value[key]);
  }
  return out;
}

/**
 * 需求分析内容指纹：忽略顶层 updatedAt，用于 Codex / 页面并发写入保护。
 * 同一份内容无论对象键顺序如何都得到同一 revision。
 */
export function analysisRevision(doc) {
  if (!doc || typeof doc !== 'object') return '';
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(stableValue(doc)), 'utf8')
    .digest('hex');
}

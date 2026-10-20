/**
 * 出码调度：同一份 IR 按目标语言渲染。
 */
import { normalizeIr } from './ir.mjs';
import { renderTs } from './emit-ts.mjs';
import { renderPython } from './emit-python.mjs';

export function emitCode(rawIr, target) {
  const ir = normalizeIr(rawIr, { target });
  const language = target === 'python' || ir.target === 'python' ? 'python' : 'ts';
  const rendered = language === 'python' ? renderPython(ir) : renderTs(ir);
  return { ...rendered, ir: { ...ir, target: language } };
}

export { normalizeIr };

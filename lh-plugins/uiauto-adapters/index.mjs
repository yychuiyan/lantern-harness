/**
 * 适配器注册表：识别项目、按 id 取适配器。
 *
 * 新增框架只需要写一个模块并加进 ADAPTERS，插件本体不感知具体框架。
 */
import { buildProbe } from './shared.mjs';

import * as playwright from './playwright.mjs';
import * as pytest from './pytest.mjs';
import * as selenium from './selenium.mjs';

/** 顺序只影响同分时的展示顺序 */
export const ADAPTERS = [playwright, pytest, selenium];

export const ADAPTER_IDS = ADAPTERS.map((adapter) => adapter.id);

export function getAdapter(id) {
  return ADAPTERS.find((adapter) => adapter.id === id) ?? null;
}

/** 给前端「框架」下拉用的清单（不做项目识别，纯静态） */
export function adapterOptions() {
  return ADAPTERS.map((adapter) => ({ id: adapter.id, label: adapter.label, kind: adapter.kind }));
}

/**
 * 识别目录里可能是什么框架，按分数从高到低。
 * @param {ReturnType<typeof buildProbe>} probe
 */
export function detectCandidates(probe) {
  if (!probe?.exists) return [];
  const list = [];
  for (const adapter of ADAPTERS) {
    let result = null;
    try {
      result = adapter.detect(probe);
    } catch {
      result = null;
    }
    if (!result || !result.score) continue;
    list.push({
      id: adapter.id,
      label: adapter.label,
      kind: result.kind ?? adapter.kind,
      score: result.score,
      evidence: result.evidence ?? [],
      controls: adapter.controls,
      ready: adapter.ready ? Boolean(adapter.ready(probe)) : true,
    });
  }
  return list.sort((a, b) => b.score - a.score);
}

/** 识别阈值：低于这个分数视为「不像」，不给挂载 */
export const MIN_DETECT_SCORE = 50;

export { buildProbe };

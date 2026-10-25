/**
 * 会话计划模式（对齐 dsh plan-mode 子集）：
 * planning = 只读探查 + submit_plan；approved = 可写实施；off = 关闭。
 */

export type PlanPhase = 'off' | 'planning' | 'approved';

export interface PlanProposal {
  title: string;
  summary: string;
  steps: string[];
}

export const PLAN_MODE_HINT_PLANNING =
  '【计划模式 · 探查中】当前禁止写操作（不可 fs_write / bash / pwsh 等）。\n' +
  '- 先用只读工具（fs_list / fs_read / fs_glob / fs_grep / web_* / kb_*）探查\n' +
  '- 形成方案后调用 submit_plan，等待用户批准；未批准前不要声称已修改文件\n' +
  '- 可用 ask_user_question / todo_write 澄清与拆解';

export const PLAN_MODE_HINT_APPROVED =
  '【计划模式 · 已批准】用户已批准方案，可以按批准内容实施（写文件 / 执行命令）。\n' +
  '- 实施中若需大幅变更方案，再次 submit_plan 征求批准\n' +
  '- 仍优先小步、可回滚的改动';

export const SUBMIT_PLAN_TOOL = {
  type: 'function' as const,
  function: {
    name: 'submit_plan',
    description:
      'Submit an implementation plan for user approval (plan mode). Blocks until the user approves or rejects.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short plan title' },
        summary: { type: 'string', description: 'What will change and why' },
        steps: {
          type: 'array',
          items: { type: 'string' },
          description: 'Ordered implementation steps',
        },
      },
      required: ['title', 'steps'],
    },
  },
};

export function parseSubmitPlanArgs(argsJson: string): PlanProposal | null {
  try {
    const a = JSON.parse(argsJson || '{}') as {
      title?: unknown;
      summary?: unknown;
      steps?: unknown;
    };
    const title = String(a.title ?? '').trim();
    const summary = String(a.summary ?? '').trim();
    const steps = Array.isArray(a.steps)
      ? a.steps.map((s) => String(s ?? '').trim()).filter(Boolean)
      : [];
    if (!title || !steps.length) return null;
    return { title, summary, steps: steps.slice(0, 24) };
  } catch {
    return null;
  }
}

/** 从会话存档恢复计划相位 */
export function normalizePlanPhase(raw: unknown): PlanPhase {
  return raw === 'planning' || raw === 'approved' ? raw : 'off';
}

/** 从会话存档恢复待批计划 */
export function normalizePlanProposal(raw: unknown): PlanProposal | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as { title?: unknown; summary?: unknown; steps?: unknown };
  const title = String(o.title ?? '').trim();
  const summary = String(o.summary ?? '').trim();
  const steps = Array.isArray(o.steps)
    ? o.steps.map((s) => String(s ?? '').trim()).filter(Boolean)
    : [];
  if (!title || !steps.length) return null;
  return { title, summary, steps: steps.slice(0, 24) };
}

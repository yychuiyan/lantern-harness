/**
 * tool-skill：按需列出 / 加载工作区 SKILL.md（需本地 /__tb_fs）。
 */

const API = '/__tb_fs';

export const SKILL_SYSTEM_HINT =
  '你可以使用 Skill 工具（本地 fs 可用时）：\n' +
  '- skill_list：列出工作区 / 项目根下约定目录中的 SKILL.md\n' +
  '- skill_load：按 id（目录名）或 path 加载技能正文到本轮上下文\n' +
  '- 需要遵循某技能流程时先 skill_list 再 skill_load，勿臆造技能内容';

export const SKILL_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'skill_validate',
      description:
        'Validate output using a registered space skill. Deterministically checks rows, template columns, source IDs, priorities and statistics; does not run a model or write business data.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' }, input: { type: 'object' } },
        required: ['id', 'input'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'skill_list',
      description:
        'List available skills (SKILL.md) under the workspace / project (.cursor/skills, .agents/skills, skills/, or */SKILL.md).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'skill_load',
      description:
        'Load a skill by id (directory name) or path to SKILL.md. Returns the skill markdown body (may be truncated).',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description:
              'Skill id / directory name from skill_list, or relative/absolute path to SKILL.md',
          },
          path: {
            type: 'string',
            description: 'Optional path to SKILL.md (alias of name)',
          },
        },
      },
    },
  },
];

export async function runSkillTool(name: string, argsJson: string): Promise<string> {
  if (name === 'skill_validate') {
    try {
      const args = JSON.parse(argsJson || '{}');
      const res = await fetch(`${API}/skill/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(8000),
      });
      return JSON.stringify(await res.json());
    } catch (e) {
      return JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  if (name === 'skill_list') {
    try {
      const res = await fetch(`${API}/skills`, { signal: AbortSignal.timeout(5000) });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        count?: number;
        skills?: Array<{ id: string; name: string; path: string }>;
        error?: string;
      };
      if (!res.ok) {
        return JSON.stringify({ ok: false, error: data.error || `HTTP ${res.status}` });
      }
      return JSON.stringify(
        {
          ok: true,
          count: data.count ?? data.skills?.length ?? 0,
          skills: data.skills ?? [],
        },
        null,
        2,
      );
    } catch (e) {
      return JSON.stringify({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  if (name === 'skill_load') {
    let args: { name?: unknown; path?: unknown; id?: unknown } = {};
    try {
      args = JSON.parse(argsJson || '{}') as typeof args;
    } catch {
      return JSON.stringify({ ok: false, error: 'invalid JSON arguments' });
    }
    const key = String(args.name ?? args.path ?? args.id ?? '').trim();
    if (!key) {
      return JSON.stringify({ ok: false, error: 'name or path is required' });
    }
    try {
      const res = await fetch(`${API}/skill-load`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: key }),
        signal: AbortSignal.timeout(8000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err =
          typeof data === 'object' && data && 'error' in data
            ? String((data as { error: string }).error)
            : `HTTP ${res.status}`;
        return JSON.stringify({ ok: false, error: err });
      }
      return JSON.stringify(data, null, 2);
    } catch (e) {
      return JSON.stringify({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return JSON.stringify({ error: `unknown tool: ${name}` });
}

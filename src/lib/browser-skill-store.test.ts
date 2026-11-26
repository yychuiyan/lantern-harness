import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { skillRequest, type SkillDetail, type SpaceSkill } from './space-skills';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('在线静态站遇到 HTML 响应时展示只读技能目录', async () => {
  globalThis.fetch = (async () =>
    new Response('<html><body>GitHub Pages</body></html>', {
      status: 404,
      headers: { 'Content-Type': 'text/html' },
    })) as typeof fetch;

  const listed = await skillRequest<{ skills: SpaceSkill[] }>('list');
  assert.ok(listed.skills.length >= 10);
  assert.ok(listed.skills.every((skill) => skill.active && skill.enabled));

  const detail = await skillRequest<{ skill: SkillDetail }>('read', {
    id: listed.skills[0]!.id,
  });
  assert.match(detail.skill.content, /在线只读预览/);
});

test('在线静态站拒绝技能写入操作', async () => {
  globalThis.fetch = (async () =>
    new Response('<html><body>GitHub Pages</body></html>', {
      status: 404,
      headers: { 'Content-Type': 'text/html' },
    })) as typeof fetch;

  await assert.rejects(
    skillRequest('create', { name: '不能创建', content: '# 内容' }),
    /在线只读预览/,
  );
  await assert.rejects(
    skillRequest('save', { id: 'preview:1', patch: { content: '# 修改' } }),
    /在线只读预览/,
  );
});

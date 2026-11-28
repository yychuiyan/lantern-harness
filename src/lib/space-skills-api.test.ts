import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { before, after, test } from 'node:test';
import connect from 'connect';
import { lhFsPlugin } from '../../builtin/session/lh-fs.mjs';
import { setActiveRoot, __resetSpaceContext } from '../../builtin/session/space-context.mjs';
let root = '',
  base = '',
  server: http.Server;
before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-skills-api-'));
  fs.mkdirSync(path.join(root, '提示词管理'));
  fs.writeFileSync(path.join(root, '提示词管理', '默认提示词.md'), '本空间基础规则');
  fs.writeFileSync(path.join(root, '提示词管理', '自定义任务.md'), '自定义正文');
  __resetSpaceContext();
  setActiveRoot(root);
  const app = connect();
  for (const plugin of [lhFsPlugin()]) {
    const configure = plugin.configureServer as unknown as (s: {
      middlewares: connect.Server;
      config: { root: string };
    }) => void;
    configure({ middlewares: app, config: { root } });
  }
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  __resetSpaceContext();
  fs.rmSync(root, { recursive: true, force: true });
});
async function request(url: string, body?: unknown) {
  const response = await fetch(
    base + url,
    body
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      : undefined,
  );
  return { status: response.status, data: await response.json() };
}
test('迁移→管理页读取→两个会话工具入口一致→基础规则使用技能正文', async () => {
  const migrated = await request('/__tb_fs/skill-store', { action: 'migrate' });
  assert.equal(migrated.status, 200);
  assert.equal(migrated.data.count, 2);
  const browser = await request('/__tb_fs/skills');
  const runner = await request('/__tb_fs/skill/list', {});
  assert.deepEqual(browser.data.skills, runner.data.skills);
  const foundation = browser.data.skills.find((x: { foundation: boolean }) => x.foundation);
  assert.ok(foundation);
  const loaded = await request('/__tb_fs/skill/read', { name: foundation.id });
  assert.equal(loaded.data.ok, true);
  assert.match(loaded.data.text, /本空间基础规则/);
  const detail = await request('/__tb_fs/skill-store', {
    action: 'read',
    id: foundation.id.replace('space:', ''),
  });
  const saved = await request('/__tb_fs/skill-store', {
    action: 'save',
    id: detail.data.skill.id,
    patch: {
      hash: detail.data.skill.hash,
      content: '新版空间基础规则',
      description: '空间基础规则说明',
    },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.skill.content, '新版空间基础规则');
  assert.equal(saved.data.skill.description, '空间基础规则说明');
  const conflict = await request('/__tb_fs/skill-store', {
    action: 'save',
    id: detail.data.skill.id,
    patch: { hash: detail.data.skill.hash, content: '过期编辑' },
  });
  assert.equal(conflict.status, 409);
  const checked = await request('/__tb_fs/skill/validate', {
    id: foundation.id.replace('space:', ''),
    input: { rows: [{ id: 'a' }, { id: 'a' }] },
  });
  assert.equal(checked.status, 200);
  assert.equal(checked.data.ok, false);
  const custom = browser.data.skills.find((x: { foundation: boolean }) => !x.foundation);
  assert.ok(custom);
  const disabled = await request('/__tb_fs/skill-store', {
    action: 'set-enabled',
    group: custom.group,
    enabled: false,
  });
  assert.equal(disabled.status, 200);
  assert.equal(
    disabled.data.skills.find((x: { id: string }) => x.id === custom.id.replace('space:', ''))
      .enabled,
    false,
  );
  const runnerOff = await request('/__tb_fs/skill/list', {});
  assert.equal(
    runnerOff.data.skills.some((x: { id: string }) => x.id === custom.id),
    false,
  );
  const enabled = await request('/__tb_fs/skill-store', {
    action: 'set-enabled',
    group: custom.group,
    enabled: true,
  });
  assert.equal(enabled.status, 200);
});

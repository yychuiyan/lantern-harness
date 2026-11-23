import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import connect from 'connect';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  BUSINESS_MAP_PROMPT_FILE,
  businessMapFilePath,
  businessMapPromptPath,
  lhBusinessMapPlugin,
} from '../../lh-plugins/lh-business-map.mjs';
import { businessLoginDir } from '../../lh-plugins/business-map/auth-paths.mjs';
import { businessMaterialDir } from '../../lh-plugins/business-map/sources.mjs';
import type { BusinessLoginStatus } from './business-map-login';
import { __resetSpaceContext, setActiveRoot } from '../../builtin/session/space-context.mjs';
import {
  listSpaceSkills,
  migrateSpaceSkills,
  setSpaceSkillGroupEnabled,
} from '../../builtin/session/space-skills.mjs';

describe('business map API', () => {
  let tmp = '';
  let server: http.Server | null = null;
  let base = '';
  let pickedDirectory = '';

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-business-map-'));
    __resetSpaceContext();
    setActiveRoot(tmp);
    const app = connect();
    const plugin = lhBusinessMapPlugin({
      pickDirectory: async () => ({ path: pickedDirectory || tmp }),
    });
    const configure = plugin.configureServer as unknown as (server: {
      config: { root: string };
      middlewares: connect.Server;
    }) => void;
    configure({ config: { root: tmp }, middlewares: app });
    const started = http.createServer(app);
    server = started;
    await new Promise<void>((resolve) => started.listen(0, '127.0.0.1', resolve));
    const address = started.address();
    if (!address || typeof address === 'string') throw new Error('未取得监听端口');
    base = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    __resetSpaceContext();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(businessMapFilePath(tmp), { force: true });
    fs.rmSync(path.dirname(businessMapFilePath(tmp)), { recursive: true, force: true });
    fs.rmSync(businessMapPromptPath(tmp), { force: true });
    fs.rmSync(path.join(tmp, '技能管理'), { recursive: true, force: true });
  });

  async function json<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${base}${url}`, init);
    const data = (await res.json()) as T;
    if (!res.ok) {
      throw Object.assign(new Error((data as { error?: string }).error || `HTTP ${res.status}`), {
        status: res.status,
        data,
      });
    }
    return data;
  }

  it('业务地图技能按空间创建，关闭后不删除', async () => {
    const on = await json<{ file: string; created: boolean }>('/__tb_business_map/prompt/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(on.file, BUSINESS_MAP_PROMPT_FILE);
    assert.equal(on.created, true);
    assert.equal(fs.existsSync(businessMapPromptPath(tmp)), true);
    const content = fs.readFileSync(businessMapPromptPath(tmp), 'utf8');
    assert.match(content, /业务地图识别技能/);
    assert.match(content, /在线文档/);
    assert.match(content, /业务流程/);
    assert.match(content, /本地业务资料/);

    await json('/__tb_business_map/prompt/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(fs.readFileSync(businessMapPromptPath(tmp), 'utf8'), content);
  });

  it('关联技能停用后仍使用已保存规则，不阻断业务地图识别', async () => {
    await json('/__tb_business_map/prompt/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    migrateSpaceSkills(tmp);
    const skill = listSpaceSkills(tmp).find((item) => item.legacyPath === BUSINESS_MAP_PROMPT_FILE);
    assert.ok(skill);
    setSpaceSkillGroupEnabled(tmp, skill.group, false);
    const result = await json<{ content: string }>('/__tb_business_map/prompt');
    assert.match(result.content, /业务地图识别技能/);
  });

  it('系统源码目录通过同源原生目录接口选择', async () => {
    pickedDirectory = path.join(tmp, 'source-project');
    fs.mkdirSync(pickedDirectory, { recursive: true });
    const configFile = path.join(tmp, '.lantern', 'local', 'app.config.json');
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify({ plugins: { businessMap: true } }));

    const picked = await json<{ dir: string }>('/__tb_business_map/pick-directory', {
      method: 'POST',
    });
    assert.equal(picked.dir, pickedDirectory);

    await assert.rejects(
      json('/__tb_business_map/pick-directory', {
        method: 'POST',
        headers: { Origin: 'https://example.com' },
      }),
      (error: unknown) => (error as { status?: number }).status === 403,
    );
  });

  it('本地业务资料可上传、列出，并在删除系统时清理', async () => {
    const configFile = path.join(tmp, '.lantern', 'local', 'app.config.json');
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify({ plugins: { businessMap: true } }));
    const created = await json<{ systemId: string; store: { revision: number } }>(
      '/__tb_business_map/systems',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: 0, system: { name: '资料系统' } }),
      },
    );
    const materialUrl =
      '/__tb_business_map/systems/' +
      created.systemId +
      '/materials?name=' +
      encodeURIComponent('业务说明.md');
    const uploaded = await json<{ material: { name: string; supported: boolean } }>(materialUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/markdown' },
      body: Buffer.from('# 业务说明\n审批后进入派单') as unknown as BodyInit,
    });
    assert.equal(uploaded.material.name, '业务说明.md');
    assert.equal(uploaded.material.supported, true);
    const listed = await json<{ materials: Array<{ name: string; size: number }> }>(
      '/__tb_business_map/systems/' + created.systemId + '/materials',
    );
    assert.equal(listed.materials[0]?.name, '业务说明.md');
    assert.ok((listed.materials[0]?.size || 0) > 0);
    assert.equal(fs.existsSync(businessMaterialDir(tmp, created.systemId)), true);
    await json('/__tb_business_map/systems/' + created.systemId, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: created.store.revision }),
    });
    assert.equal(fs.existsSync(businessMaterialDir(tmp, created.systemId)), false);
  });

  it('系统表单不再提交登录态字段时保留历史配置', async () => {
    const created = await json<{
      store: { revision: number };
      systemId: string;
    }>('/__tb_business_map/systems', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        revision: 0,
        system: {
          name: '历史系统',
          sourceDir: '/tmp/old-source',
          loginState: '.auth/legacy.json',
        },
      }),
    });
    const updated = await json<{
      store: { systems: Array<{ loginState: string; sourceDir: string }> };
    }>(`/__tb_business_map/systems/${created.systemId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        revision: created.store.revision,
        system: { name: '历史系统', sourceDir: '/tmp/new-source' },
      }),
    });
    assert.equal(updated.store.systems[0].sourceDir, '/tmp/new-source');
    assert.equal(updated.store.systems[0].loginState, '.auth/legacy.json');
  });

  it('系统登录配置独立保存、密码不回显、跨源拦截且不改地图 revision', async () => {
    const previousConfigHome = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = path.join(tmp, 'user-config');
    try {
      const configFile = path.join(tmp, '.lantern', 'local', 'app.config.json');
      fs.mkdirSync(path.dirname(configFile), { recursive: true });
      fs.writeFileSync(configFile, JSON.stringify({ plugins: { businessMap: true } }));
      const created = await json<{ systemId: string; store: { revision: number } }>(
        '/__tb_business_map/systems',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            revision: 0,
            system: { name: '登录配置系统', entryUrl: 'https://example.com' },
          }),
        },
      );
      const route = '/__tb_business_map/systems/' + created.systemId + '/login';
      const initial = await json<BusinessLoginStatus>(route);
      const saved = await json<BusinessLoginStatus>(route, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...initial.config,
          mode: 'password',
          username: 'fixture-user',
          password: 'fixture-password',
        }),
      });
      assert.equal(saved.hasPassword, true);
      assert.ok(!JSON.stringify(saved).includes('fixture-password'));
      const reread = await fetch(base + route);
      assert.equal(reread.headers.get('cache-control'), 'no-store');
      assert.ok(!(await reread.text()).includes('fixture-password'));
      assert.ok(!fs.readFileSync(businessMapFilePath(tmp), 'utf8').includes('fixture-password'));
      await assert.rejects(
        json(route, {
          method: 'PUT',
          headers: { Origin: 'https://unrelated.example', 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...saved.config, password: 'overwrite' }),
        }),
        (error: unknown) => (error as { status: number }).status === 403,
      );
      const map = await json<{ store: { revision: number } }>('/__tb_business_map');
      assert.equal(map.store.revision, created.store.revision);
      const updated = await json<{ store: { revision: number } }>(
        '/__tb_business_map/systems/' + created.systemId,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            revision: created.store.revision,
            system: { name: '登录配置系统-已保存' },
          }),
        },
      );
      assert.ok(updated.store.revision > created.store.revision);
      assert.equal(fs.existsSync(businessLoginDir(tmp, created.systemId)), true);
      await json('/__tb_business_map/systems/' + created.systemId, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: updated.store.revision }),
      });
      assert.equal(fs.existsSync(businessLoginDir(tmp, created.systemId)), false);
    } finally {
      if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousConfigHome;
    }
  });

  it('创建示例系统并按 revision 写回', async () => {
    const empty = await json<{ store: { revision: number } }>('/__tb_business_map');
    const demo = await json<{
      store: {
        revision: number;
        systems: Array<{ id: string; functions: unknown[]; flows: unknown[] }>;
      };
      systemId: string;
    }>('/__tb_business_map/demo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: empty.store.revision }),
    });
    assert.equal(demo.store.systems.length, 1);
    const example = demo.store.systems[0] as unknown as {
      name: string;
      entryUrl: string;
      flows: { steps: { system: string }[] }[];
    };
    assert.equal(example.name, '示例系统');
    assert.equal(example.entryUrl, 'https://example.com');
    assert.ok(
      example.flows.every((flow) => flow.steps.every((step) => step.system.startsWith('示例'))),
    );
    assert.equal(demo.store.systems[0].functions.length, 12);
    assert.equal(demo.store.systems[0].flows.length, 5);

    await assert.rejects(
      json('/__tb_business_map/demo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: empty.store.revision }),
      }),
      (error: unknown) =>
        Boolean(
          error &&
          typeof error === 'object' &&
          'status' in error &&
          (error as { status: number }).status === 409,
        ),
    );
  });

  it('AI 提案应用前不修改正式功能，应用后保留人工确认字段', async () => {
    const empty = await json<{ store: { revision: number } }>('/__tb_business_map');
    const demo = await json<{
      store: {
        revision: number;
        systems: Array<{
          id: string;
          functions: Array<{ id: string; name: string; purpose: string; confirmed: boolean }>;
          proposals: Array<{ id: string; status: string; action: string }>;
        }>;
      };
      systemId: string;
    }>('/__tb_business_map/demo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: empty.store.revision }),
    });
    const before = demo.store.systems[0].functions.length;
    const analyzed = await json<{
      store: {
        revision: number;
        systems: Array<{
          id: string;
          functions: unknown[];
          proposals: Array<{ id: string; status: string; action: string }>;
        }>;
      };
      system: {
        id: string;
        functions: unknown[];
        proposals: Array<{ id: string; status: string; action: string }>;
      };
    }>(`/__tb_business_map/systems/${demo.systemId}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        revision: demo.store.revision,
        sources: {
          page: { enabled: true, scope: '全部菜单', pageCount: 28 },
          doc: { enabled: true, scope: '当前系统关联文档' },
          code: { enabled: false },
        },
      }),
    });
    const saved = await json<{
      store: { systems: Array<{ lastAnalysis: { status: string; pageCount: number } }> };
    }>('/__tb_business_map');
    assert.equal(saved.store.systems[0].lastAnalysis.status, 'demo');
    assert.equal(saved.store.systems[0].lastAnalysis.pageCount, 0);
    assert.equal(analyzed.system.functions.length, before);
    assert.ok(analyzed.system.proposals.length >= 4);

    const add = analyzed.system.proposals.find(
      (proposal) => proposal.action === 'add' && proposal.status === 'pending',
    );
    assert.ok(add);
    const applied = await json<{
      store: {
        revision: number;
        systems: Array<{ functions: Array<{ confirmed: boolean }> }>;
      };
    }>(`/__tb_business_map/systems/${demo.systemId}/proposals/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        revision: analyzed.store.revision,
        ids: [add!.id],
      }),
    });
    assert.equal(applied.store.systems[0].functions.length, before + 1);
    assert.ok(applied.store.systems[0].functions.some((item) => item.confirmed));
  });

  it('真实系统不会被固定工单示例污染', async () => {
    const created = await json<{ store: { revision: number }; systemId: string }>(
      '/__tb_business_map/systems',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: 0, system: { name: '财务管理系统' } }),
      },
    );
    await assert.rejects(
      json(`/__tb_business_map/systems/${created.systemId}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          revision: created.store.revision,
          sources: { page: { enabled: true, pageCount: 999 } },
        }),
      }),
      (error: unknown) => (error as { status?: number }).status === 501,
    );
    const after = await json<{
      store: { revision: number; systems: Array<{ proposals: unknown[] }> };
    }>('/__tb_business_map');
    assert.equal(after.store.revision, created.store.revision);
    assert.deepEqual(after.store.systems[0].proposals, []);
  });

  it('发布时阻断待审核提案和未连接分支', async () => {
    const empty = await json<{ store: { revision: number } }>('/__tb_business_map');
    const demo = await json<{
      store: { revision: number };
      systemId: string;
    }>('/__tb_business_map/demo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: empty.store.revision }),
    });
    const analyzed = await json<{ store: { revision: number } }>(
      `/__tb_business_map/systems/${demo.systemId}/analyze`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          revision: demo.store.revision,
          sources: { page: { enabled: true, scope: '全部菜单' } },
        }),
      },
    );
    await assert.rejects(
      json(`/__tb_business_map/systems/${demo.systemId}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: analyzed.store.revision }),
      }),
      (error: unknown) => {
        if (!error || typeof error !== 'object' || !('data' in error)) return false;
        const check = (error as { data: { check?: { ok?: boolean } } }).data.check;
        return check?.ok === false;
      },
    );
  });
});

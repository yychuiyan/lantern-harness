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
import { assistantDir } from '../../lh-plugins/business-map/assistant.mjs';
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
    assert.match(content, /第一阶段：功能目录/);
    assert.match(content, /第二阶段：业务流程/);
    assert.match(content, /menuPath/);

    await json('/__tb_business_map/prompt/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(fs.readFileSync(businessMapPromptPath(tmp), 'utf8'), content);
  });

  it('业务地图关联技能默认启用且不可停用', async () => {
    await json('/__tb_business_map/prompt/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    migrateSpaceSkills(tmp);
    const skill = listSpaceSkills(tmp).find(
      (item: { legacyPath: string }) => item.legacyPath === BUSINESS_MAP_PROMPT_FILE,
    );
    assert.ok(skill);
    assert.equal(skill.enabled, true);
    assert.throws(
      () => setSpaceSkillGroupEnabled(tmp, skill.group, false),
      /已关联业务的技能不可停用/,
    );
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

  it('复制系统支持完整凭据、仅登录配置和不复制登录配置，但不复制功能、历史或登录态', async () => {
    const previousConfigHome = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = path.join(tmp, 'copy-login-config');
    try {
      const file = businessMapFilePath(tmp);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        JSON.stringify({
          version: 2,
          revision: 4,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          systems: [
            {
              id: 'sys_source',
              name: '客服工单',
              description: '客服受理与派单',
              entryUrl: 'https://example.com/work-order',
              sourceDir: '/tmp/work-order-source',
              loginState: '.auth/legacy.json',
              docs: { requirements: true, knowledge: false, scope: '客服需求' },
              analysisScope: '工单菜单',
              status: 'published',
              publishedRevision: 4,
              lastAnalysis: {
                at: '2026-01-01T00:00:00.000Z',
                status: 'done',
                pageCount: 8,
                docCount: 2,
                codeFileCount: 3,
                summary: '历史识别',
              },
              directories: [
                {
                  id: 'dir_1',
                  parentId: '',
                  name: '工单受理',
                  order: 0,
                  source: 'manual',
                  menuPath: ['工单受理'],
                  entryUrl: '',
                  evidence: [],
                },
              ],
              functions: [
                {
                  id: 'fn_1',
                  code: 'F-001',
                  name: '新建工单',
                  directoryId: 'dir_1',
                  direction: '新建',
                  purpose: '登记诉求',
                },
              ],
              flows: [{ id: 'flow_1', code: 'P1', name: '新建工单流程', steps: [] }],
              proposals: [
                {
                  id: 'prop_1',
                  action: 'add',
                  targetType: 'function',
                  title: '待审核功能',
                  status: 'pending',
                },
              ],
            },
          ],
        }),
      );

      const initialLogin = await json<{ config: { revision?: string } }>(
        '/__tb_business_map/systems/sys_source/login',
      );
      await json('/__tb_business_map/systems/sys_source/login', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          revision: initialLogin.config.revision || '',
          mode: 'password',
          username: 'fixture-user',
          password: 'fixture-password',
          loginUrl: 'https://example.com/login',
          usernameSelector: '#username',
          passwordSelector: '#password',
          submitSelector: '#submit',
        }),
      });

      const copied = await json<{
        systemId: string;
        store: {
          revision: number;
          systems: Array<{
            id: string;
            name: string;
            description: string;
            entryUrl: string;
            sourceDir: string;
            loginState: string;
            docs: { requirements: boolean; knowledge: boolean; scope: string };
            analysisScope: string;
            status: string;
            publishedRevision: number;
            lastAnalysis: unknown;
            directories: unknown[];
            functions: unknown[];
            flows: unknown[];
            proposals: unknown[];
          }>;
        };
      }>('/__tb_business_map/systems/sys_source/copy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: 4 }),
      });
      assert.notEqual(copied.systemId, 'sys_source');
      assert.equal(copied.store.revision, 5);
      const copy = copied.store.systems.find((item) => item.id === copied.systemId)!;
      assert.equal(copy.name, '客服工单（副本）');
      assert.equal(copy.description, '客服受理与派单');
      assert.equal(copy.entryUrl, 'https://example.com/work-order');
      assert.equal(copy.sourceDir, '/tmp/work-order-source');
      assert.deepEqual(copy.docs, {
        requirements: true,
        knowledge: false,
        scope: '客服需求',
      });
      assert.equal(copy.analysisScope, '工单菜单');
      assert.equal(copy.status, 'draft');
      assert.equal(copy.publishedRevision, 0);
      assert.equal(copy.lastAnalysis, null);
      assert.equal(copy.loginState, '');
      assert.deepEqual(copy.directories, []);
      assert.deepEqual(copy.functions, []);
      assert.deepEqual(copy.flows, []);
      assert.deepEqual(copy.proposals, []);

      const copiedLogin = await json<{
        config: {
          mode: string;
          username: string;
          loginUrl: string;
          usernameSelector: string;
          passwordSelector: string;
          submitSelector: string;
        };
        hasPassword: boolean;
        stateReady: boolean;
        savedAt: string;
      }>(`/__tb_business_map/systems/${copied.systemId}/login`);
      assert.equal(copiedLogin.config.mode, 'password');
      assert.equal(copiedLogin.config.username, 'fixture-user');
      assert.equal(copiedLogin.config.loginUrl, 'https://example.com/login');
      assert.equal(copiedLogin.config.usernameSelector, '#username');
      assert.equal(copiedLogin.config.passwordSelector, '#password');
      assert.equal(copiedLogin.config.submitSelector, '#submit');
      assert.equal(copiedLogin.hasPassword, true);
      assert.equal(copiedLogin.savedAt, '');
      assert.equal(copiedLogin.stateReady, false);

      const second = await json<{
        systemId: string;
        store: { revision: number; systems: Array<{ id: string; name: string }> };
      }>('/__tb_business_map/systems/sys_source/copy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: copied.store.revision }),
      });
      assert.equal(
        second.store.systems.find((item) => item.id === second.systemId)?.name,
        '客服工单（副本 2）',
      );

      const configurationOnly = await json<{
        systemId: string;
        store: { revision: number };
      }>('/__tb_business_map/systems/sys_source/copy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          revision: second.store.revision,
          loginCopyMode: 'configuration',
        }),
      });
      const configurationLogin = await json<{
        config: {
          mode: string;
          username: string;
          loginUrl: string;
          usernameSelector: string;
        };
        hasPassword: boolean;
        stateReady: boolean;
      }>(`/__tb_business_map/systems/${configurationOnly.systemId}/login`);
      assert.equal(configurationLogin.config.mode, 'password');
      assert.equal(configurationLogin.config.username, 'fixture-user');
      assert.equal(configurationLogin.config.loginUrl, 'https://example.com/login');
      assert.equal(configurationLogin.config.usernameSelector, '#username');
      assert.equal(configurationLogin.hasPassword, false);
      assert.equal(configurationLogin.stateReady, false);

      const withoutLogin = await json<{ systemId: string; store: { revision: number } }>(
        '/__tb_business_map/systems/sys_source/copy',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            revision: configurationOnly.store.revision,
            loginCopyMode: 'none',
          }),
        },
      );
      const emptyLogin = await json<{
        config: { mode: string };
        hasPassword: boolean;
        stateReady: boolean;
      }>(`/__tb_business_map/systems/${withoutLogin.systemId}/login`);
      assert.equal(emptyLogin.config.mode, 'none');
      assert.equal(emptyLogin.hasPassword, false);
      assert.equal(emptyLogin.stateReady, false);

      await assert.rejects(
        json('/__tb_business_map/systems/sys_source/copy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            revision: withoutLogin.store.revision,
            loginCopyMode: 'invalid',
          }),
        }),
        (error: unknown) => (error as { status?: number }).status === 400,
      );
    } finally {
      if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousConfigHome;
    }
  });

  it('旧版业务地图自动迁移为目录树并保留功能、流程 ID', async () => {
    const file = businessMapFilePath(tmp);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        revision: 7,
        systems: [
          {
            id: 'sys_legacy',
            name: '旧版系统',
            functions: [
              {
                id: 'fn_legacy',
                code: 'F-001',
                name: '旧功能',
                domain: '受理域',
                module: '工单受理',
              },
            ],
            flows: [
              {
                id: 'flow_legacy',
                code: 'P1',
                name: '旧流程',
                steps: [{ id: 'step_legacy', title: '受理', functionId: 'fn_legacy' }],
              },
            ],
            proposals: [],
          },
        ],
      }),
    );
    const loaded = await json<{
      store: {
        revision: number;
        version: number;
        systems: Array<{
          directories: Array<{ id: string; parentId: string; name: string }>;
          functions: Array<{ id: string; directoryId: string }>;
          flows: Array<{ id: string; steps: Array<{ functionId: string }> }>;
        }>;
      };
    }>('/__tb_business_map');
    assert.equal(loaded.store.version, 2);
    assert.equal(loaded.store.revision, 8);
    const system = loaded.store.systems[0];
    assert.equal(system.functions[0].id, 'fn_legacy');
    assert.equal(system.flows[0].steps[0].functionId, 'fn_legacy');
    const domain = system.directories.find((item) => item.name === '受理域');
    const module = system.directories.find((item) => item.name === '工单受理');
    assert.ok(domain);
    assert.ok(module);
    assert.equal(module.parentId, domain.id);
    assert.equal(system.functions[0].directoryId, module.id);
    assert.equal(fs.existsSync(file + '.v1.bak'), true);
  });

  it('目录支持新建、移动校验和显式级联删除', async () => {
    const created = await json<{ systemId: string; store: { revision: number } }>(
      '/__tb_business_map/systems',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: 0, system: { name: '目录树系统' } }),
      },
    );
    const root = await json<{
      store: { revision: number };
      directory: { id: string };
    }>(`/__tb_business_map/systems/${created.systemId}/directories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        revision: created.store.revision,
        directory: { name: '受理域' },
      }),
    });
    const child = await json<{
      store: { revision: number };
      directory: { id: string };
    }>(`/__tb_business_map/systems/${created.systemId}/directories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        revision: root.store.revision,
        directory: { name: '工单受理', parentId: root.directory.id },
      }),
    });
    const fn = await json<{ store: { revision: number }; item: { id: string } }>(
      `/__tb_business_map/systems/${created.systemId}/functions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          revision: child.store.revision,
          function: { name: '新建工单', directoryId: child.directory.id },
        }),
      },
    );
    const flow = await json<{ store: { revision: number }; item: { id: string } }>(
      `/__tb_business_map/systems/${created.systemId}/flows`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          revision: fn.store.revision,
          flow: {
            name: '新建工单流程',
            steps: [{ title: '登记', functionId: fn.item.id }],
          },
        }),
      },
    );
    await assert.rejects(
      json(`/__tb_business_map/systems/${created.systemId}/directories/${root.directory.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          revision: flow.store.revision,
          directory: { parentId: child.directory.id },
        }),
      }),
      /不能移动到自身或其子目录/,
    );
    await assert.rejects(
      json(`/__tb_business_map/systems/${created.systemId}/directories/${root.directory.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: flow.store.revision }),
      }),
      (error: unknown) => (error as { status?: number }).status === 409,
    );
    const moved = await json<{
      store: {
        revision: number;
        systems: Array<{
          directories: Array<{ id: string; parentId: string; order: number }>;
          functions: Array<{ id: string; directoryId: string; order: number }>;
        }>;
      };
    }>(`/__tb_business_map/systems/${created.systemId}/tree/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        revision: flow.store.revision,
        kind: 'function',
        id: fn.item.id,
        parentId: root.directory.id,
      }),
    });
    const movedFunction = moved.store.systems[0].functions.find((item) => item.id === fn.item.id);
    assert.equal(movedFunction?.directoryId, root.directory.id);
    assert.equal(movedFunction?.order, 0);
    const removed = await json<{
      store: {
        revision: number;
        systems: Array<{
          directories: unknown[];
          functions: unknown[];
          flows: Array<{ steps: Array<{ functionId: string }> }>;
        }>;
      };
    }>(`/__tb_business_map/systems/${created.systemId}/directories/${root.directory.id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: moved.store.revision, cascade: true }),
    });
    assert.equal(removed.store.systems[0].directories.length, 0);
    assert.equal(removed.store.systems[0].functions.length, 0);
    assert.equal(removed.store.systems[0].flows[0].steps[0].functionId, '');
    assert.ok(removed.store.revision > moved.store.revision);
  });

  it('AI 会话接口持久化状态，缺少模型时不启动回合', async () => {
    const created = await json<{ systemId: string; store: { revision: number } }>(
      '/__tb_business_map/systems',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: 0, system: { name: 'AI 会话系统' } }),
      },
    );
    const initial = await json<{
      session: { systemId: string; status: string; phase: string };
    }>(`/__tb_business_map/systems/${created.systemId}/assistant`);
    assert.equal(initial.session.systemId, created.systemId);
    assert.equal(initial.session.status, 'idle');
    assert.equal(initial.session.phase, 'directory');
    await assert.rejects(
      json(`/__tb_business_map/systems/${created.systemId}/assistant/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          revision: created.store.revision,
          phase: 'directory',
          message: '识别功能目录',
        }),
      }),
      /配置可用模型/,
    );
    const reset = await json<{ session: { status: string; messages: unknown[] } }>(
      `/__tb_business_map/systems/${created.systemId}/assistant/reset`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      },
    );
    assert.equal(reset.session.status, 'idle');
    assert.equal(reset.session.messages.length, 0);
  });

  it('AI 目录草案应用后写入真实目录树并保留功能引用', async () => {
    const created = await json<{ systemId: string; store: { revision: number } }>(
      '/__tb_business_map/systems',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: 0, system: { name: 'AI 应用系统' } }),
      },
    );
    const file = path.join(assistantDir(tmp), `${created.systemId}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        systemId: created.systemId,
        phase: 'directory',
        status: 'awaiting_confirmation',
        runId: '',
        seq: 1,
        messages: [],
        events: [],
        progress: { stage: 'done', label: '草案等待确认', current: 1, total: 1, percent: 100 },
        proposal: {
          kind: 'directory',
          message: '目录草案',
          directories: [
            {
              key: 'd1',
              parentKey: '',
              name: '工单受理',
              menuPath: ['工单受理'],
              entryUrl: '',
            },
            {
              key: 'd2',
              parentKey: '',
              name: '派单处理',
              menuPath: ['派单处理'],
              entryUrl: '',
            },
          ],
          functions: [
            {
              name: '新建工单',
              directoryKey: 'd1',
              purpose: '登记诉求',
              entry: '/new',
              menuPath: ['工单受理', '新建工单'],
              evidence: [
                {
                  id: 'ev_ai',
                  type: 'page',
                  title: '新建工单页',
                  ref: '/new',
                  note: '登记诉求',
                  confidence: 'medium',
                },
              ],
            },
          ],
          warnings: [],
        },
        directoryApplied: false,
        flowApplied: false,
      }),
    );
    const beforeApply = await json<{
      store: {
        revision: number;
        systems: Array<{ directories: unknown[]; functions: unknown[] }>;
      };
    }>('/__tb_business_map');
    assert.equal(beforeApply.store.revision, created.store.revision);
    assert.deepEqual(beforeApply.store.systems[0].directories, []);
    assert.deepEqual(beforeApply.store.systems[0].functions, []);
    const applied = await json<{
      store: {
        revision: number;
        systems: Array<{
          directories: Array<{ id: string; name: string; order: number }>;
          functions: Array<{ id: string; name: string; directoryId: string }>;
        }>;
      };
      session: { directoryApplied: boolean; phase: string; status: string };
    }>(`/__tb_business_map/systems/${created.systemId}/assistant/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: created.store.revision }),
    });
    const system = applied.store.systems[0];
    const directory = system.directories.find((item) => item.name === '工单受理');
    const nextDirectory = system.directories.find((item) => item.name === '派单处理');
    const fn = system.functions.find((item) => item.name === '新建工单');
    assert.ok(directory);
    assert.ok(nextDirectory);
    assert.ok(directory.order < nextDirectory.order);
    assert.equal(fn?.directoryId, directory.id);
    assert.equal(applied.session.directoryApplied, true);
    assert.equal(applied.session.phase, 'flow');
    assert.equal(applied.session.status, 'idle');
  });

  it('AI 流程草案应用后写入流程并保留功能关联', async () => {
    const created = await json<{ systemId: string; store: { revision: number } }>(
      '/__tb_business_map/systems',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: 0, system: { name: 'AI 流程系统' } }),
      },
    );
    const fn = await json<{ store: { revision: number }; item: { id: string } }>(
      `/__tb_business_map/systems/${created.systemId}/functions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          revision: created.store.revision,
          function: { name: '新建工单', purpose: '登记诉求' },
        }),
      },
    );
    const file = path.join(assistantDir(tmp), `${created.systemId}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        systemId: created.systemId,
        phase: 'flow',
        status: 'awaiting_confirmation',
        runId: '',
        seq: 1,
        messages: [],
        events: [],
        progress: { stage: 'done', label: '草案等待确认', current: 1, total: 1, percent: 100 },
        proposal: {
          kind: 'flow',
          message: '流程草案',
          flows: [
            {
              name: '新建工单流程',
              result: '工单创建完成',
              steps: [
                {
                  n: 1,
                  title: '登记并提交工单',
                  role: '受理人员',
                  system: 'AI 流程系统',
                  functionId: fn.item.id,
                  input: '诉求',
                  output: '工单',
                  next: '',
                  branch: '',
                  branchBroken: false,
                  manual: false,
                },
              ],
              evidence: [],
            },
          ],
          warnings: [],
        },
        directoryApplied: true,
        flowApplied: false,
      }),
    );
    const applied = await json<{
      store: {
        systems: Array<{
          flows: Array<{ name: string; steps: Array<{ functionId: string }> }>;
        }>;
      };
      session: { flowApplied: boolean; status: string };
    }>(`/__tb_business_map/systems/${created.systemId}/assistant/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: fn.store.revision }),
    });
    assert.equal(applied.store.systems[0].flows[0].name, '新建工单流程');
    assert.equal(applied.store.systems[0].flows[0].steps[0].functionId, fn.item.id);
    assert.equal(applied.session.flowApplied, true);
    assert.equal(applied.session.status, 'idle');
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
      const stateFile = path.join(businessLoginDir(tmp, created.systemId), '.auth', 'admin.json');
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, '{}');
      const sameOrigin = await json<{ store: { revision: number } }>(
        '/__tb_business_map/systems/' + created.systemId,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            revision: updated.store.revision,
            system: { entryUrl: 'https://example.com/workorder' },
          }),
        },
      );
      assert.equal(fs.existsSync(stateFile), true);
      const crossOrigin = await json<{ store: { revision: number } }>(
        '/__tb_business_map/systems/' + created.systemId,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            revision: sameOrigin.store.revision,
            system: { entryUrl: 'https://other.example/workorder' },
          }),
        },
      );
      assert.equal(fs.existsSync(stateFile), false);
      await json('/__tb_business_map/systems/' + created.systemId, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: crossOrigin.store.revision }),
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

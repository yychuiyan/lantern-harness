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
import { __resetSpaceContext, setActiveRoot } from '../../builtin/session/space-context.mjs';

describe('business map API', () => {
  let tmp = '';
  let server: http.Server | null = null;
  let base = '';

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-business-map-'));
    __resetSpaceContext();
    setActiveRoot(tmp);
    const app = connect();
    const plugin = lhBusinessMapPlugin();
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

  it('提示词按空间创建，关闭后不删除', async () => {
    const on = await json<{ file: string; created: boolean }>('/__tb_business_map/prompt/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(on.file, BUSINESS_MAP_PROMPT_FILE);
    assert.equal(on.created, true);
    assert.equal(fs.existsSync(businessMapPromptPath(tmp)), true);
    const content = fs.readFileSync(businessMapPromptPath(tmp), 'utf8');
    assert.match(content, /业务地图识别提示词/);

    await json('/__tb_business_map/prompt/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(fs.readFileSync(businessMapPromptPath(tmp), 'utf8'), content);
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

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import connect from 'connect';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createLanternMcpServer } from '../../cli/mcp-server.mjs';
import { lhStatsPlugin, DEFAULT_TEST_DIMENSIONS } from '../../lh-plugins/lh-stats.mjs';
import { setActiveRoot, __resetSpaceContext } from '../../builtin/session/space-context.mjs';

test('通用测试统计 MCP 使用真实 API，覆盖记录、维度、汇总和并发保护', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-test-stats-mcp-'));
  const app = connect();
  let server: http.Server | undefined;
  let mcp: ReturnType<typeof createLanternMcpServer> | undefined;
  const client = new Client({ name: 'stats-test', version: '1' });
  const dataOf = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return result.structuredContent as Record<string, any>;
  };
  const listed = () => dataOf('lantern_test_stats_list');
  const fails = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, JSON.stringify(result));
    return JSON.stringify(result);
  };
  try {
    __resetSpaceContext();
    setActiveRoot(root);
    lhStatsPlugin().configureServer({ middlewares: app } as never);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const apiBase = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    mcp = createLanternMcpServer({ apiBase, version: 'test' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(a), mcp.connect(b)]);

    await t.test('只读发现、过滤与空查询不创建内容目录', async () => {
      const tools = await client.listTools();
      assert.equal(
        tools.tools.filter((tool) => tool.name.startsWith('lantern_test_stats_')).length,
        7,
      );
      assert.equal(
        tools.tools.find((tool) => tool.name === 'lantern_test_stats_list')?.annotations
          ?.readOnlyHint,
        true,
      );
      const first = await listed();
      assert.deepEqual(first.items, []);
      assert.equal(first.revision, (await listed()).revision);
      assert.equal(fs.existsSync(path.join(root, '测试统计')), false);
      await fails('lantern_test_stats_list', { from: '2026-11-25', to: '2026-11-24' });
    });

    await t.test('新增维度不伪造记录，过期版本拒绝新增', async () => {
      const before = await listed();
      const added = await dataOf('lantern_test_stats_dimension_create', {
        expectedRevision: before.revision,
        name: '回归用例',
      });
      assert.ok(added.dimensions.includes('回归用例'));
      assert.equal((await listed()).items.length, 0);
      assert.match(
        await fails('lantern_test_stats_create', {
          expectedRevision: before.revision,
          items: [{ date: '2026-11-24', dimensions: ['回归用例'], count: 1 }],
        }),
        /已被其他操作修改/,
      );
    });

    await t.test('新增与分维度日期汇总沿用页面数量，不混入空草稿', async () => {
      const before = await listed();
      const created = await dataOf('lantern_test_stats_create', {
        expectedRevision: before.revision,
        items: [
          { date: '2026-11-23', dimensions: ['回归用例'], count: 10 },
          { date: '2026-11-24', dimensions: ['功能测试用例'], count: 20 },
        ],
      });
      assert.equal(created.items[0].source, 'ai');
      const legacy = await fetch(apiBase + '/__tb_test_stats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [{ date: '2026-11-24', dimensions: [], count: 999 }] }),
      });
      assert.equal(legacy.status, 200);
      const all = await listed();
      assert.equal(all.summary.records, 2);
      assert.equal(all.summary.total, 30);
      assert.equal(
        (await dataOf('lantern_test_stats_list', { includeDrafts: true })).items.length,
        3,
      );
      const filtered = await dataOf('lantern_test_stats_list', {
        from: '2026-11-24',
        to: '2026-11-24',
        dimension: '功能测试用例',
      });
      assert.equal(filtered.items.length, 1);
      assert.deepEqual(filtered.summary.byDate, [{ date: '2026-11-24', count: 20 }]);
      assert.deepEqual(filtered.summary.byDimension, [{ dimension: '功能测试用例', count: 20 }]);
    });

    await t.test('增量修改保留未指定字段，使用最新版本避免覆盖', async () => {
      const before = await listed();
      const item = before.items.find((row: { dimensions: string[] }) =>
        row.dimensions.includes('回归用例'),
      );
      const changed = await dataOf('lantern_test_stats_update', {
        expectedRevision: before.revision,
        id: item.id,
        count: 0,
      });
      assert.equal(changed.item.count, 0);
      assert.equal(changed.item.date, item.date);
      assert.deepEqual(changed.item.dimensions, item.dimensions);
      await fails('lantern_test_stats_update', {
        expectedRevision: before.revision,
        id: item.id,
        count: 99,
      });
      await fails('lantern_test_stats_create', {
        expectedRevision: changed.revision,
        items: [{ date: '2026-02-30', dimensions: ['回归用例'], count: 1 }],
      });
      await fails('lantern_test_stats_update', { expectedRevision: changed.revision, id: item.id });
      assert.equal(
        (await listed()).items.find((row: { id: string }) => row.id === item.id).count,
        0,
      );
    });

    await t.test('重命名更新关联记录，被引用维度拒绝删除，默认维度删除后不会复活', async () => {
      let data = await listed();
      const renamed = await dataOf('lantern_test_stats_dimension_rename', {
        expectedRevision: data.revision,
        from: '回归用例',
        to: '版本回归',
      });
      assert.equal(renamed.replaced, 1);
      assert.ok(
        renamed.items.some((row: { dimensions: string[] }) => row.dimensions.includes('版本回归')),
      );
      assert.match(
        await fails('lantern_test_stats_dimension_delete', {
          expectedRevision: renamed.revision,
          name: '版本回归',
        }),
        /还有 1 条记录/,
      );
      data = await listed();
      const unused = DEFAULT_TEST_DIMENSIONS.find((name) => name === '测试计划')!;
      await dataOf('lantern_test_stats_dimension_delete', {
        expectedRevision: data.revision,
        name: unused,
      });
      assert.equal((await listed()).dimensions.includes(unused), false);
      data = await listed();
      const id = data.items.find((row: { dimensions: string[] }) =>
        row.dimensions.includes('版本回归'),
      ).id;
      const deleted = await dataOf('lantern_test_stats_delete', {
        expectedRevision: data.revision,
        ids: [id],
      });
      assert.equal(deleted.removed, 1);
      assert.equal((await listed()).items.length, 1);
      await dataOf('lantern_test_stats_dimension_delete', {
        expectedRevision: deleted.revision,
        name: '版本回归',
      });
      assert.equal((await listed()).dimensions.includes('版本回归'), false);
    });

    await t.test('空间切换后旧 revision 不能写入相同内容的新空间', async () => {
      const firstRoot = path.join(root, 'first'),
        secondRoot = path.join(root, 'second');
      setActiveRoot(firstRoot);
      const first = await listed();
      setActiveRoot(secondRoot);
      const second = await listed();
      assert.notEqual(first.revision, second.revision);
      await fails('lantern_test_stats_create', {
        expectedRevision: first.revision,
        items: [{ date: '2026-11-24', dimensions: ['接口测试用例'], count: 1 }],
      });
      assert.equal((await listed()).items.length, 0);
      setActiveRoot(root);
    });
  } finally {
    await client.close();
    await mcp?.close();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    __resetSpaceContext();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

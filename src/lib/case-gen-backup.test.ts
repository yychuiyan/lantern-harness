import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { backupCaseForRegeneration } from './case-gen-run';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('首次生成不备份，重新生成已有用例时调用备份接口', async () => {
  const calls: { url: string; body: unknown }[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return new Response(
      JSON.stringify({
        ok: true,
        backup: '功能测试/备份列表/旧稿_bak_20261125-100000.xlsx',
        name: '旧稿_bak_20261125-100000.xlsx',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;

  assert.equal(await backupCaseForRegeneration(), '');
  assert.equal(calls.length, 0);

  const backup = await backupCaseForRegeneration('功能测试/旧稿.xlsx');
  assert.equal(backup, '功能测试/备份列表/旧稿_bak_20261125-100000.xlsx');
  assert.deepEqual(calls, [
    {
      url: '/__tb_casereview/backups/create',
      body: { path: '功能测试/旧稿.xlsx' },
    },
  ]);
});

test('重新生成前备份失败时阻止覆盖并给出明确错误', async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ok: false, error: '文件不存在' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;

  await assert.rejects(
    backupCaseForRegeneration('功能测试/旧稿.xlsx'),
    /重新生成前备份旧用例失败：文件不存在/,
  );
});

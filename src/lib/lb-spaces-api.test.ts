/**
 * 数据空间 HTTP 接口的集成测试：
 * - 用临时数据根起本地服务，走真实 HTTP 打 `/__tb_spaces`
 * - 重点验证「有会话在跑时拒绝切换」的并发保护（靠 __sessionRunsForTest 注入状态）
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  __resetSpaceContext,
  ensureSpaceContext,
  getDataRoot,
  publicSpacePath,
} from '../../builtin/session/space-context.mjs';
import { __sessionRunsForTest } from '../../builtin/session/session-runs.mjs';
import { startLocalServer } from '../../cli/server.mjs';

const ORIGINAL_XDG = process.env.XDG_CONFIG_HOME;

let home = '';
let base = '';
let managed = '';
let server: { close: () => void } | null = null;
let origin = '';

/** 取一个当前空闲的端口（startLocalServer 会把 0 当成「未指定」而回落到 4321） */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

function api(p: string): string {
  return `${origin}${p}`;
}

async function getJson(p: string): Promise<Record<string, unknown>> {
  const res = await fetch(api(p));
  return (await res.json()) as Record<string, unknown>;
}

async function postJson(
  p: string,
  body: unknown,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(api(p), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
}

async function putJson(
  p: string,
  body: unknown,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(api(p), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
}

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-api-home-'));
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-api-base-'));
  // 新建空间与拷贝进来的空间文件夹都落在选中的文件夹下（池根 = base）
  managed = base;
  process.env.XDG_CONFIG_HOME = home;

  const regPath = path.join(home, 'lantern-harness', 'spaces.json');
  fs.mkdirSync(path.dirname(regPath), { recursive: true });
  fs.writeFileSync(regPath, JSON.stringify({ activeId: 'public', spaces: [] }, null, 2));

  __resetSpaceContext();
  const port = await freePort();
  const started = (await startLocalServer({ dataRoot: base, port })) as unknown as {
    server: { address: () => { port: number }; close: () => void };
  };
  server = started.server;
  origin = `http://127.0.0.1:${started.server.address().port}`;
});

after(() => {
  // fetch 走 keep-alive，不主动断开的话 server.close() 会一直等连接
  (server as unknown as { closeAllConnections?: () => void })?.closeAllConnections?.();
  server?.close();
  __sessionRunsForTest.clear();
  if (ORIGINAL_XDG === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = ORIGINAL_XDG;
  for (const d of [home, base]) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

describe('GET /__tb_spaces', () => {
  it('返回公共空间与当前数据根，体积默认不统计', async () => {
    const d = await getJson('/__tb_spaces');
    assert.equal(d.ok, true);
    assert.equal(d.activeId, 'public');
    assert.equal(d.dataRoot, publicSpacePath(base));

    const spaces = d.spaces as Array<Record<string, unknown>>;
    assert.equal(spaces.length, 1);
    assert.equal(spaces[0]!.isPublic, true);
    assert.equal(spaces[0]!.bytes, null, '默认不应统计体积');
  });

  it('stats=1 时才统计体积', async () => {
    const d = await getJson('/__tb_spaces?stats=1');
    const spaces = d.spaces as Array<Record<string, unknown>>;
    assert.equal(typeof spaces[0]!.bytes, 'number');
  });
});

describe('POST /__tb_spaces/create 与 switch', () => {
  it('创建会铺设数据根骨架，并可顺带切换', async () => {
    const { data } = await postJson('/__tb_spaces/create', {
      name: '接口空间',
      switch: true,
    });
    assert.equal(data.ok, true);
    assert.equal(data.switched, true);

    const space = data.space as { path: string };
    // prepareSpaceDir 铺好隐藏元数据目录；除提示词管理外，插件关闭时内容目录不预先创建
    for (const dirName of ['.lantern', '.lantern/config', '.lantern/local']) {
      assert.equal(fs.existsSync(path.join(space.path, dirName)), true, `缺少 ${dirName}`);
    }
    for (const dirName of ['需求文档库', '用例管理', '知识库管理', '测试模板库']) {
      assert.equal(
        fs.existsSync(path.join(space.path, dirName)),
        false,
        `插件关闭时不应建 ${dirName}`,
      );
    }
    assert.equal(
      fs.existsSync(path.join(space.path, '提示词管理', '默认提示词.md')),
      true,
      '新空间应始终带上默认提示词',
    );
    assert.equal(
      path.resolve(path.dirname(space.path)),
      path.resolve(base),
      '新空间应与公共空间同级，直接落在选中的文件夹下',
    );
    assert.equal(getDataRoot(), space.path);

    const cfg = await getJson('/__tb_config');
    assert.equal(
      String((cfg.paths as { local: string }).local).startsWith(space.path),
      true,
      '配置路径应指向新空间',
    );
  });

  it('创建时可写入默认提示词，提示词接口按当前空间读取且不可删除', async () => {
    const custom = '你是接口测试助手，只回答本空间的接口问题。';
    const created = await postJson('/__tb_spaces/create', {
      name: '带提示词空间',
      switch: true,
      systemPrompt: custom,
    });
    assert.equal(created.data.ok, true);
    const space = created.data.space as { path: string };
    const onDisk = fs.readFileSync(path.join(space.path, '提示词管理', '默认提示词.md'), 'utf8');
    assert.equal(onDisk.trim(), custom);

    const read = await postJson('/__tb_prompts/read', { path: '默认提示词.md' });
    assert.equal(read.status, 200);
    assert.equal(String(read.data.content ?? '').trim(), custom);

    const del = await postJson('/__tb_prompts/delete', { path: '默认提示词.md' });
    assert.equal(del.status, 403);

    const listed = await postJson('/__tb_prompts/list', { path: '.' });
    const names = ((listed.data.entries as Array<{ name: string; type: string }>) ?? [])
      .filter((e) => e.type === 'file')
      .map((e) => e.name);
    assert.equal(names.includes('默认提示词.md'), true);
    assert.equal(names.includes('功能测试用例提示词v1.0.md'), false);

    const kb = await postJson('/__tb_knowledge/list', { path: '.' });
    const kbNames = ((kb.data.entries as Array<{ name: string; type: string }>) ?? [])
      .filter((e) => e.type === 'file')
      .map((e) => e.name);
    assert.equal(kbNames.includes('功能测试用例编写规范.md'), false);
  });

  it('名称非法 / 重名返回 400', async () => {
    const bad = await postJson('/__tb_spaces/create', { name: '../escape' });
    assert.equal(bad.status, 400);
    assert.equal(bad.data.ok, false);

    const dup = await postJson('/__tb_spaces/create', { name: '接口空间' });
    assert.equal(dup.status, 400);
  });

  it('有会话在运行时拒绝切换（409），且数据根不变', async () => {
    const before = getDataRoot();
    // 注入一条运行中的会话
    __sessionRunsForTest.set('fake-session', { status: 'running' } as never);

    const blocked = await postJson('/__tb_spaces/switch', { id: 'public' });
    assert.equal(blocked.status, 409);
    assert.match(String(blocked.data.error), /仍有会话在运行/);
    assert.equal(getDataRoot(), before, '被拒绝时数据根不应改变');

    __sessionRunsForTest.clear();
    const ok = await postJson('/__tb_spaces/switch', { id: 'public' });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.ok, true);
    assert.equal(getDataRoot(), publicSpacePath(base));
  });
});

describe('POST /__tb_spaces/delete 安全语义', () => {
  it('purge 未显式确认时拒绝（400）', async () => {
    const listed = await getJson('/__tb_spaces');
    const target = (listed.spaces as Array<Record<string, unknown>>).find((s) => !s.isPublic);
    assert.ok(target);

    const res = await fetch(api('/__tb_spaces/delete'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: target!.id, purge: true }),
    });
    assert.equal(res.status, 400);
    assert.match(String(((await res.json()) as { error?: string }).error), /显式确认/);
  });

  it('公共空间不可删除 / 不可重命名', async () => {
    const del = await postJson('/__tb_spaces/delete', { id: 'public', purge: false });
    assert.equal(del.status, 400);
    assert.match(String(del.data.error), /不支持删除/);

    const ren = await postJson('/__tb_spaces/rename', { id: 'public', name: '改名' });
    assert.equal(ren.status, 400);
    assert.match(String(ren.data.error), /不支持重命名/);
  });

  it('删除当前激活空间后回落到公共空间', async () => {
    const created = await postJson('/__tb_spaces/create', { name: '待清理', switch: true });
    const space = created.data.space as { id: string; path: string };
    assert.equal(getDataRoot(), space.path);

    const del = await postJson('/__tb_spaces/delete', {
      id: space.id,
      purge: true,
      confirm: true,
    });
    assert.equal(del.status, 200);
    assert.equal(del.data.purged, true);
    assert.equal(fs.existsSync(space.path), false);
    assert.equal(getDataRoot(), publicSpacePath(base), '应回落到公共空间');
    assert.equal((await getJson('/__tb_spaces')).activeId, 'public');
  });
});

describe('GET/PUT /__tb_config 模型全局', () => {
  it('首次读取时把空间里的旧模型迁到全局', async () => {
    const modelsPath = path.join(home, 'lantern-harness', 'models.json');
    if (fs.existsSync(modelsPath)) fs.unlinkSync(modelsPath);

    const fp = path.join(getDataRoot(), '.lantern', 'local', 'app.config.json');
    const local = fs.existsSync(fp) ? JSON.parse(fs.readFileSync(fp, 'utf8')) : {};
    local.model = {
      activeId: 'p_legacy',
      providers: [
        {
          id: 'p_legacy',
          name: '旧',
          baseURL: 'https://legacy.example/v1',
          model: 'old',
          apiKey: 'sk-old',
        },
      ],
    };
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, JSON.stringify(local, null, 2));

    const got = await getJson('/__tb_config');
    const gotModel = (got.config as { model: { activeId: string } }).model;
    assert.equal(gotModel.activeId, 'p_legacy');
    const disk = JSON.parse(fs.readFileSync(modelsPath, 'utf8')) as { activeId: string };
    assert.equal(disk.activeId, 'p_legacy');
    const spaceCfg = JSON.parse(fs.readFileSync(fp, 'utf8')) as { model?: unknown };
    assert.equal(spaceCfg.model, undefined);
  });

  it('模型写入本机 models.json，切换空间后仍可读', async () => {
    const current = await getJson('/__tb_config');
    const cfg = current.config as Record<string, unknown>;
    const model = {
      activeId: 'p_global',
      reasoningEffort: 'high',
      providers: [
        {
          id: 'p_global',
          name: '共享',
          baseURL: 'https://api.example.com/v1',
          model: 'demo',
          apiKey: 'sk-shared',
        },
      ],
    };
    const saved = await putJson('/__tb_config', { config: { ...cfg, model } });
    assert.equal(saved.status, 200);
    assert.equal((saved.data.config as { model: { activeId: string } }).model.activeId, 'p_global');

    const modelsPath = path.join(home, 'lantern-harness', 'models.json');
    assert.equal(fs.existsSync(modelsPath), true);
    const disk = JSON.parse(fs.readFileSync(modelsPath, 'utf8')) as { activeId: string };
    assert.equal(disk.activeId, 'p_global');

    const spaceLocal = String((current.paths as { local: string }).local);
    const spaceCfg = JSON.parse(fs.readFileSync(spaceLocal, 'utf8')) as { model?: unknown };
    assert.equal(spaceCfg.model, undefined);

    const created = await postJson('/__tb_spaces/create', { name: '模型共用空间', switch: true });
    assert.equal(created.data.ok, true);
    const again = await getJson('/__tb_config');
    const againModel = (
      again.config as { model: { activeId: string; providers: { id: string }[] } }
    ).model;
    assert.equal(againModel.activeId, 'p_global');
    assert.equal(againModel.providers[0]?.id, 'p_global');
    assert.equal(String((again.paths as { models: string }).models), modelsPath);
  });
});

describe('POST /__tb_spaces/validate-name', () => {
  it('透传名称校验结果', async () => {
    assert.equal((await postJson('/__tb_spaces/validate-name', { name: 'ok名' })).data.ok, true);
    assert.equal((await postJson('/__tb_spaces/validate-name', { name: 'a/b' })).data.ok, false);
  });
});

describe('GET /__tb_spaces/export 范围', () => {
  it('scope=content 时排除密钥与会话，scope 缺省为完整备份', async () => {
    const created = await postJson('/__tb_spaces/create', { name: '导出空间' });
    const space = created.data.space as { id: string; path: string };
    assert.equal(created.data.ok, true);

    fs.writeFileSync(path.join(space.path, '.env'), 'TW_API_KEY=sk-x\n', 'utf8');
    fs.mkdirSync(path.join(space.path, '.lantern', 'local', 'memories'), { recursive: true });
    fs.writeFileSync(
      path.join(space.path, '.lantern', 'local', 'memories', 'USER.md'),
      'p',
      'utf8',
    );
    fs.mkdirSync(path.join(space.path, '需求文档库'), { recursive: true });
    fs.writeFileSync(path.join(space.path, '需求文档库', 'a.md'), '# a', 'utf8');

    const JSZip = (await import('jszip')).default;

    const contentRes = await fetch(api(`/__tb_spaces/export?id=${space.id}&scope=content`));
    assert.equal(contentRes.status, 200);
    const contentZip = await JSZip.loadAsync(Buffer.from(await contentRes.arrayBuffer()));
    const names = Object.keys(contentZip.files);
    assert.ok(names.includes('需求文档库/a.md'));
    assert.equal(names.includes('.env'), false);
    assert.equal(
      names.some((n) => n.startsWith('.lantern/local/memories/')),
      false,
    );

    // 非法 scope 退回完整备份（宁可多带，也不能误以为不含密钥）
    const weird = await fetch(api(`/__tb_spaces/export?id=${space.id}&scope=whatever`));
    const weirdZip = await JSZip.loadAsync(Buffer.from(await weird.arrayBuffer()));
    assert.ok(Object.keys(weirdZip.files).includes('.env'));
  });
});

describe('POST /__tb_spaces/discover', () => {
  it('纳入空间池内带 space.json 清单的文件夹', async () => {
    // 模拟「整体拷进来」：手工造一个带清单的目录
    const incoming = path.join(managed, '外部拷入');
    fs.mkdirSync(path.join(incoming, '.lantern', 'local'), { recursive: true });
    fs.writeFileSync(
      path.join(incoming, '.lantern', 'space.json'),
      JSON.stringify({
        kind: 'ai-testbench-space',
        schema: 1,
        id: 'sp_outer',
        name: '外部拷入',
        createdAt: 1,
      }),
      'utf8',
    );

    const out = await postJson('/__tb_spaces/discover', {});
    assert.equal(out.status, 200);
    assert.equal(out.data.ok, true);
    const added = out.data.added as Array<{ name: string; path: string }>;
    assert.ok(
      added.some((s) => s.name === '外部拷入' && path.resolve(s.path) === path.resolve(incoming)),
    );

    // 纳入后应出现在列表里
    const listed = await getJson('/__tb_spaces');
    const names = (listed.spaces as Array<Record<string, unknown>>).map((s) => s.name);
    assert.ok(names.includes('外部拷入'));
  });

  it('只有内容目录的文件夹先列为候选，确认纳入后只登记、不写元数据', async () => {
    const bare = path.join(managed, '只拷了内容');
    fs.mkdirSync(path.join(bare, '用例管理'), { recursive: true });
    fs.writeFileSync(path.join(bare, '用例管理', 'a.md'), '# a', 'utf8');

    // 第一次扫描：不擅自纳入，只列为候选
    const first = await postJson('/__tb_spaces/discover', {});
    assert.equal(first.status, 200);
    const added = (first.data.added as Array<{ name: string }>).map((s) => s.name);
    assert.equal(added.includes('只拷了内容'), false, '缺元数据的目录不能自动纳入');
    const candidates = first.data.candidates as Array<{ path: string; hasContent?: boolean }>;
    const cand = candidates.find((c) => path.resolve(c.path) === path.resolve(bare));
    assert.ok(cand, '应作为候选返回，等用户确认');
    assert.equal(cand.hasContent, true, '带内容库目录的候选应被标记');

    // 用户确认：纳入列表，但不写 .lantern（文件夹保持原样）
    const adopt = await postJson('/__tb_spaces/discover', { adopt: [bare] });
    assert.equal(adopt.status, 200);
    const adopted = adopt.data.added as Array<{ name: string; external?: boolean }>;
    assert.ok(adopted.some((s) => s.name === '只拷了内容' && s.external === true));
    assert.equal(fs.existsSync(path.join(bare, '.lantern')), false, '不得写入任何空间元数据');
    assert.equal(fs.readFileSync(path.join(bare, '用例管理', 'a.md'), 'utf8'), '# a');

    const listed = await getJson('/__tb_spaces');
    const names = (listed.spaces as Array<Record<string, unknown>>).map((s) => s.name);
    assert.ok(names.includes('只拷了内容'));

    // 再扫一次：外部空间不会被补写 space.json
    const again = await postJson('/__tb_spaces/discover', {});
    const backfilled = again.data.backfilled as string[];
    assert.equal(backfilled.includes('只拷了内容'), false, '外部纳入的空间不补写清单');
    assert.equal(fs.existsSync(path.join(bare, '.lantern')), false);
  });
});

describe('空间上下文自愈', () => {
  it('进程重启后 GET /__tb_spaces 把数据根恢复成注册表里的活动空间', async () => {
    const created = await postJson('/__tb_spaces/create', { name: '自愈空间', switch: true });
    assert.equal(created.data.ok, true);
    const space = created.data.space as { id: string; path: string };

    // 模拟重启：内存上下文清空后只按池根初始化，activeRoot 会退回公共空间
    __resetSpaceContext();
    ensureSpaceContext(base);
    assert.equal(path.resolve(getDataRoot()), path.resolve(publicSpacePath(base)));

    const healed = await getJson('/__tb_spaces');
    assert.equal(healed.activeId, space.id);
    assert.equal(
      path.resolve(getDataRoot()),
      path.resolve(space.path),
      '不恢复的话，分组目录 / 配置都会写进公共空间',
    );
  });
});

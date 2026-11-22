import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import connect from 'connect';
import { lhBusinessMapPlugin, businessMapFilePath } from '../../lh-plugins/lh-business-map.mjs';
import {
  analysisDir,
  normalizeAnalysisConfig,
  validateCandidates,
} from '../../lh-plugins/business-map/jobs.mjs';
import {
  collectFiles,
  makeEvidence,
  walkFiles,
  readableUrl,
} from '../../lh-plugins/business-map/sources.mjs';
import { __resetSpaceContext, setActiveRoot } from '../../builtin/session/space-context.mjs';
import { resolveContentRoot } from '../../builtin/session/space-layout.mjs';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
describe('真实业务地图后台识别', () => {
  let root = '',
    second = '',
    base = '',
    modelBase = '';
  let server: http.Server, modelServer: http.Server;
  let modelCalls = 0,
    delay = 0,
    malformed = false;
  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'business-analysis-'));
    second = fs.mkdtempSync(path.join(os.tmpdir(), 'business-analysis-other-'));
    __resetSpaceContext();
    setActiveRoot(root);
    const app = connect();
    lhBusinessMapPlugin().configureServer({ config: { root }, httpServer: null, middlewares: app });
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    modelServer = http.createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      modelCalls++;
      const request = JSON.parse(body),
        data = JSON.parse(request.messages[1].content);
      await sleep(delay);
      const candidate = {
        action: 'add',
        targetType: 'function',
        title: '费用报销',
        scopeTarget: data.scope.targets[0]?.key || '',
        risk: '低',
        confidence: 'high',
        payload: {
          name: '费用报销',
          domain: '财务域',
          module: '费用管理',
          purpose: '报销费用并交财务审核',
          roles: ['申请人'],
        },
        evidence: data.sources.map((source: { id: string; content: string }) => ({
          sourceId: source.id,
          quote: source.content.trim().slice(0, 25),
        })),
      };
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: malformed ? 'not json' : JSON.stringify({ candidates: [candidate] }),
              },
            },
          ],
          usage: { total_tokens: 123 },
        }),
      );
    });
    await new Promise<void>((resolve) => modelServer.listen(0, '127.0.0.1', resolve));
    modelBase = `http://127.0.0.1:${(modelServer.address() as { port: number }).port}/v1`;
  });
  after(async () => {
    await Promise.all([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => modelServer.close(() => resolve())),
    ]);
    __resetSpaceContext();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(second, { recursive: true, force: true });
  });
  beforeEach(() => {
    setActiveRoot(root);
    modelCalls = 0;
    delay = 0;
    malformed = false;
    fs.rmSync(analysisDir(root), { recursive: true, force: true });
    fs.rmSync(businessMapFilePath(root), { force: true });
  });
  async function json(route: string, body?: unknown) {
    const res = await fetch(
      base + '/__tb_business_map' + route,
      body === undefined
        ? undefined
        : {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
    );
    const data = await res.json();
    return { status: res.status, ...data };
  }
  async function setup(doc = true, code = true) {
    const created = await json('/systems', { revision: 0, system: { name: '财务系统' } });
    const docs = resolveContentRoot(root, '需求文档库').abs;
    fs.mkdirSync(docs, { recursive: true });
    fs.writeFileSync(
      path.join(docs, '财务需求.md'),
      '费用报销提交后进入财务审核，审核通过后生成凭证。',
    );
    const sourceDir = path.join(root, 'source');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(
      path.join(sourceDir, 'expense.ts'),
      '// 费用报销提交后进入财务审核，审核通过后生成凭证。\nexport const route = "/expense";',
    );
    return {
      created,
      config: {
        scope: { mode: 'single', targets: [{ name: '费用报销' }] },
        sources: { page: { enabled: false }, doc: { enabled: doc }, code: { enabled: code } },
        documents: doc ? ['需求文档库/财务需求.md'] : [],
        sourceDir,
        autoDraft: true,
      },
      settings: { baseURL: modelBase, model: 'fake-model', apiKey: 'CANARY_SECRET_DO_NOT_PERSIST' },
    };
  }
  async function finish(systemId: string, id: string) {
    for (let i = 0; i < 100; i++) {
      const result = await json(`/systems/${systemId}/analyses/${id}`);
      if (!['queued', 'running'].includes(result.job?.status)) return result.job;
      await sleep(30);
    }
    throw new Error('任务未结束');
  }
  it('真实资料调用模型，两类证据自动入草稿；后台任务不保存模型凭证', async () => {
    const { created, config, settings } = await setup();
    const started = await json(`/systems/${created.systemId}/analyses`, {
      revision: created.store.revision,
      config,
      settings,
    });
    assert.equal(started.status, 202);
    const job = await finish(created.systemId, started.job.id);
    assert.equal(job.status, 'succeeded');
    assert.equal(job.result.autoApplied.length, 1);
    assert.equal(modelCalls, 1);
    assert.equal(job.usage.totalTokens, 123);
    assert.equal(job.coverage.documents, 1);
    assert.equal(job.coverage.codeFiles, 1);
    const stored = await json('');
    const fn = stored.store.systems[0].functions[0];
    assert.equal(fn.name, '费用报销');
    assert.equal(fn.source, 'ai');
    assert.equal(fn.confirmed, false);
    assert.equal(fn.evidence.length, 2);
    const disk = fs.readFileSync(path.join(analysisDir(root), started.job.id + '.json'), 'utf8');
    assert.ok(!disk.includes(settings.apiKey));
    assert.equal(job.checkpoint, undefined);
  });
  it('单来源只生成待审核提案，不自动修改功能', async () => {
    const { created, config, settings } = await setup(true, false);
    const start = await json(`/systems/${created.systemId}/analyses`, {
      revision: created.store.revision,
      config,
      settings,
    });
    const job = await finish(created.systemId, start.job.id);
    assert.equal(job.result.pending, 1);
    assert.equal(job.result.autoApplied.length, 0);
    const store = await json('');
    assert.equal(store.store.systems[0].functions.length, 0);
    assert.equal(store.store.systems[0].proposals.length, 1);
  });
  it('重试复用模型检查点并去重，保留批次撤回能力', async () => {
    const { created, config, settings } = await setup();
    const start = await json(`/systems/${created.systemId}/analyses`, {
      revision: created.store.revision,
      config,
      settings,
    });
    await finish(created.systemId, start.job.id);
    await json(`/systems/${created.systemId}/analyses/${start.job.id}/retry`, { settings });
    const job = await finish(created.systemId, start.job.id);
    assert.equal(modelCalls, 1);
    assert.equal(job.result.autoApplied.length, 1);
    const undo = await json(`/systems/${created.systemId}/analyses/${job.id}/rollback`, {});
    assert.equal(undo.job.result.rollback.removed.length, 1);
    assert.equal((await json('')).store.systems[0].functions.length, 0);
  });
  it('修改后的自动新增功能不会被批次撤回', async () => {
    const { created, config, settings } = await setup();
    const prefix = `/systems/${created.systemId}/analyses`;
    const start = await json(prefix, { revision: created.store.revision, config, settings });
    const job = await finish(created.systemId, start.job.id);
    const store = await json('');
    const fn = store.store.systems[0].functions[0];
    const response = await fetch(
      base + `/__tb_business_map/systems/${created.systemId}/functions/${fn.id}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          revision: store.store.revision,
          function: { purpose: '人工修订口径' },
        }),
      },
    );
    assert.equal(response.status, 200);
    const undo = await json(`${prefix}/${job.id}/rollback`, {});
    assert.equal(undo.job.result.rollback.skipped.length, 1);
  });
  it('切换空间后后台结果仍写回原空间，其他空间不能读取任务', async () => {
    delay = 150;
    const { created, config, settings } = await setup();
    const prefix = `/systems/${created.systemId}/analyses`;
    const start = await json(prefix, { revision: created.store.revision, config, settings });
    setActiveRoot(second);
    assert.equal((await json(`${prefix}/${start.job.id}`)).status, 404);
    await sleep(250);
    assert.equal(fs.existsSync(businessMapFilePath(second)), false);
    setActiveRoot(root);
    const job = await finish(created.systemId, start.job.id);
    assert.equal(job.result.autoApplied.length, 1);
  });
  it('取消终止任务，不应用模型结果；重复启动被拒绝', async () => {
    delay = 200;
    const { created, config, settings } = await setup();
    const prefix = `/systems/${created.systemId}/analyses`;
    const start = await json(prefix, { revision: created.store.revision, config, settings });
    const duplicate = await json(prefix, { revision: created.store.revision, config, settings });
    assert.equal(duplicate.status, 409);
    await json(`${prefix}/${start.job.id}/cancel`, {});
    await sleep(80);
    const job = await finish(created.systemId, start.job.id);
    assert.equal(job.status, 'cancelled');
    assert.equal((await json('')).store.systems[0].functions.length, 0);
  });
  it('识别期间人工新增同名功能时转为提案，不覆盖最新人工内容', async () => {
    delay = 150;
    const { created, config, settings } = await setup();
    const prefix = `/systems/${created.systemId}/analyses`;
    const start = await json(prefix, { revision: created.store.revision, config, settings });
    await json(`/systems/${created.systemId}/functions`, {
      revision: created.store.revision,
      function: {
        name: '费用报销',
        purpose: '人工最新口径',
        confirmed: true,
        lockedFields: ['purpose'],
      },
    });
    const job = await finish(created.systemId, start.job.id);
    assert.equal(job.result.autoApplied.length, 0);
    assert.equal(job.result.pending, 1);
    const current = (await json('')).store.systems[0];
    assert.equal(current.functions.length, 1);
    assert.equal(current.functions[0].purpose, '人工最新口径');
    assert.equal(current.proposals[0].action, 'update');
  });
  it('多个功能未全部识别时报告部分完成，全量范围正常识别', async () => {
    const { created, config, settings } = await setup();
    const prefix = `/systems/${created.systemId}/analyses`;
    const start = await json(prefix, {
      revision: created.store.revision,
      config: {
        ...config,
        scope: { mode: 'multiple', targets: [{ name: '费用报销' }, { name: '库存查询' }] },
      },
      settings,
    });
    const job = await finish(created.systemId, start.job.id);
    assert.equal(job.status, 'partial');
    assert.ok(job.issues.some((issue: string) => issue.includes('库存查询')));
    const current = await json('');
    const full = await json(prefix, {
      revision: current.store.revision,
      config: { ...config, scope: { mode: 'system', targets: [] } },
      settings,
    });
    assert.equal((await finish(created.systemId, full.job.id)).status, 'succeeded');
  });
  it('可关闭自动入草稿；服务重启遗留任务标为中断并恢复', async () => {
    const { created, config, settings } = await setup();
    const prefix = `/systems/${created.systemId}/analyses`;
    const start = await json(prefix, {
      revision: created.store.revision,
      config: { ...config, autoDraft: false },
      settings,
    });
    const job = await finish(created.systemId, start.job.id);
    assert.equal(job.result.autoApplied.length, 0);
    assert.equal(job.result.pending, 1);
    const dest = path.join(analysisDir(root), job.id + '.json');
    const disk = JSON.parse(fs.readFileSync(dest, 'utf8'));
    disk.status = 'running';
    fs.writeFileSync(dest, JSON.stringify(disk));
    assert.equal((await json(`${prefix}/${job.id}`)).job.status, 'interrupted');
    await json(`${prefix}/${job.id}/retry`, { settings });
    assert.equal((await finish(created.systemId, job.id)).status, 'succeeded');
    assert.equal(modelCalls, 1);
    for (const name of fs.readdirSync(analysisDir(root)))
      assert.ok(
        !fs.readFileSync(path.join(analysisDir(root), name), 'utf8').includes(settings.apiKey),
      );
  });
  it('无效 JSON 保留来源检查点，修复模型后可重试', async () => {
    malformed = true;
    const { created, config, settings } = await setup();
    const prefix = `/systems/${created.systemId}/analyses`;
    const start = await json(prefix, { revision: created.store.revision, config, settings });
    const failed = await finish(created.systemId, start.job.id);
    assert.equal(failed.status, 'failed');
    malformed = false;
    await json(`${prefix}/${failed.id}/retry`, { settings });
    assert.equal((await finish(created.systemId, failed.id)).status, 'succeeded');
  });
});

describe('范围、证据与只读边界', () => {
  it('非法证据和范围外候选不能入图', () => {
    const evidence = [makeEvidence('doc', '需求.md', '费用报销需要财务审核')];
    const system = { functions: [], flows: [] };
    const config = { scope: { mode: 'single', targets: [{ key: '费用报销', name: '费用报销' }] } };
    const raw = {
      candidates: [
        {
          action: 'add',
          targetType: 'function',
          scopeTarget: '费用报销',
          payload: { name: '费用报销' },
          evidence: [{ sourceId: evidence[0].id, quote: '这是虚构的页面内容' }],
        },
      ],
    };
    assert.equal(validateCandidates(raw, evidence, config, system).candidates.length, 0);
    raw.candidates[0].evidence[0].quote = evidence[0].content;
    raw.candidates[0].scopeTarget = '库存';
    assert.equal(validateCandidates(raw, evidence, config, system).candidates.length, 0);
  });
  it('指定和批量范围校验数量，全量不携带目标；不隐式读取全库', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-scope-'));
    try {
      const system = { functions: [], sourceDir: '', entryUrl: '' };
      const config = {
        scope: { mode: 'single', targets: [] },
        sources: { code: { enabled: true } },
      };
      assert.throws(() => normalizeAnalysisConfig(config, system, root), /1 个功能/);
      config.scope = { mode: 'multiple', targets: [] };
      assert.throws(() => normalizeAnalysisConfig(config, system, root), /至少需要 2/);
      const full = normalizeAnalysisConfig(
        { ...config, scope: { mode: 'system', targets: [{ name: '不应保留' }] } },
        system,
        root,
      );
      assert.deepEqual(full.scope.targets, []);
      assert.throws(
        () => normalizeAnalysisConfig({ ...config, scope: { mode: 'invalid' } }, system, root),
        /范围无效/,
      );
      const byName = normalizeAnalysisConfig(
        { ...config, scope: { mode: 'single', targets: [{ name: '费用报销' }] } },
        { ...system, functions: [{ id: 'existing', name: '费用报销' }] },
        root,
      );
      assert.equal(byName.scope.targets[0].functionId, 'existing');

      assert.throws(
        () => normalizeAnalysisConfig({ sources: { doc: { enabled: true } } }, system, root),
        /明确选择/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it('长段正文分批保留完整内容，不因单行超过12000字符而丢失', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-long-source-'));
    try {
      const docs = resolveContentRoot(root, '需求文档库').abs;
      fs.mkdirSync(docs, { recursive: true });
      const content = '费用报销业务规则'.repeat(4000);
      fs.writeFileSync(path.join(docs, '长需求.md'), content);
      const result = await collectFiles(
        root,
        { sourceDir: '' },
        {
          sources: { doc: { enabled: true }, code: { enabled: false } },
          documents: ['需求文档库/长需求.md'],
        },
        { signal: new AbortController().signal, onProgress: () => {} },
      );
      assert.equal(
        result.evidence.map((item: { content: string }) => item.content).join(''),
        content,
      );
      assert.ok(result.evidence.length > 1);
      assert.ok(result.evidence.every((item: { content: string }) => item.content.length <= 12000));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it('来源正文达到总预算时保留准确上限并报告部分覆盖', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-budget-source-'));
    try {
      for (let i = 0; i < 10; i++)
        fs.writeFileSync(path.join(root, `file${i}.ts`), 'x'.repeat(240000));
      const result = await collectFiles(
        root,
        { sourceDir: root },
        {
          sources: { doc: { enabled: false }, code: { enabled: true } },
          sourceDir: root,
          exclusions: [],
        },
        { signal: new AbortController().signal, onProgress: () => {} },
      );
      assert.equal(
        result.evidence.reduce(
          (n: number, item: { content: string }) => n + item.content.length,
          0,
        ),
        2000000,
      );
      assert.ok(result.issues.some((issue: string) => issue.includes('200万字符')));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it('源码不跟随符号链接、不读取密钥、依赖和构建文件', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-files-'));
    try {
      fs.writeFileSync(path.join(root, '.env.json'), '{"secret":"x"}');
      fs.writeFileSync(path.join(root, 'normal.ts'), 'function demo(){}');
      fs.symlinkSync('/etc/hosts', path.join(root, 'outside.txt'));
      fs.mkdirSync(path.join(root, 'node_modules'));
      fs.writeFileSync(path.join(root, 'node_modules', 'dep.ts'), '');
      assert.deepEqual(
        walkFiles(root, /\.(ts|txt|json)$/).map((item: { rel: string }) => item.rel),
        ['normal.ts'],
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
    assert.equal(readableUrl('/delete?id=1', 'https://example.com'), null);
    assert.equal(readableUrl('https://other.example/a', 'https://example.com'), null);
    assert.equal(readableUrl('/list', 'https://example.com'), 'https://example.com/list');
  });
});

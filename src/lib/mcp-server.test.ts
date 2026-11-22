import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createLanternMcpServer } from '../../cli/mcp-server.mjs';
import { analysisRevision } from '../../lh-plugins/req-analysis-revision.mjs';

let api: http.Server;
let apiBase = '';
let client: Client;
let mcp: ReturnType<typeof createLanternMcpServer>;
let docs: Array<Record<string, unknown>> = [];
let requirementEntries: Array<Record<string, unknown>> = [];
let tmp = '';
let workflowPlugins: Record<string, boolean> = {
  requirements: false,
  reqAnalysis: false,
  storyReview: false,
  testPoints: false,
  unrelated: true,
};

const skills = [
  {
    id: 'requirements-1',
    key: 'space:requirements-1',
    name: '需求分析',
    variant: '需求分析提示词',
    legacyPath: '需求分析提示词.md',
    version: 3,
    instructions: '# 需求分析\n先拆原文，再写用户故事。',
    content: '必须保留 sourceRefs。',
  },
  {
    id: 'outline-1',
    key: 'space:outline-1',
    name: '原文结构提取',
    variant: '原文结构提示词',
    legacyPath: '原文结构提示词.md',
    version: 2,
    instructions: '# 原文结构\n保留标题层级。',
    content: '来源引用使用 RO 编号。',
  },
  {
    id: 'test-points-1',
    key: 'space:test-points-1',
    name: '测试点设计',
    variant: '测试点生成提示词',
    legacyPath: '测试点生成提示词.md',
    version: 4,
    instructions: '# 测试点\n覆盖五维。',
    content: '测试点必须是 P0 到 P3。',
  },
  {
    id: 'story-review-1',
    key: 'space:story-review-1',
    name: '用户故事审查',
    variant: '用户故事审查提示词',
    legacyPath: '用户故事审查提示词.md',
    version: 5,
    instructions: '# 用户故事审查\n只报可操作缺口。',
    content: '检查来源覆盖和多场景。',
  },
  {
    id: 'disabled-1',
    key: 'space:disabled-1',
    name: '停用技能',
    variant: '停用技能',
    legacyPath: '停用技能.md',
    active: false,
    version: 1,
    instructions: '# 停用技能',
    content: '不应进入自动上下文。',
  },
];

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

async function body(req: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function saveDoc(input: Record<string, unknown>, existing?: Record<string, unknown>) {
  const current = (existing || {
    id: `ra_${docs.length + 1}`,
    sourcePath: input.sourcePath,
    title: input.title || '需求分析',
    outline: [],
    stories: [],
    check: null,
    testPoints: null,
  }) as Record<string, unknown>;
  const next = {
    ...current,
    ...input,
    stories: Array.isArray(input.stories)
      ? input.stories.map((story, index) => ({
          ...(story as Record<string, unknown>),
          id: `US-${String(index + 1).padStart(3, '0')}`,
        }))
      : current.stories,
    updatedAt: new Date().toISOString(),
  };
  if (existing) {
    docs = docs.map((doc) => (doc.id === current.id ? next : doc));
  } else {
    docs.push(next);
  }
  return next;
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-mcp-test-'));
  api = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/__tb_config') {
      if (req.method === 'GET') {
        return send(res, 200, {
          ok: true,
          configTarget: tmp,
          config: { plugins: workflowPlugins },
        });
      }
      const input = await body(req);
      assert.equal(input.configTarget, tmp);
      workflowPlugins = input.config.plugins;
      return send(res, 200, {
        ok: true,
        configTarget: tmp,
        config: input.config,
      });
    }
    if (url.pathname === '/__tb_spaces') {
      return send(res, 200, {
        activeId: 'space-1',
        spaces: [{ id: 'space-1', name: '测试空间', path: '/tmp/space-1' }],
      });
    }
    if (url.pathname === '/__tb_fs/skill-store' && req.method === 'POST') {
      const input = await body(req);
      if (input.action === 'list') return send(res, 200, { ok: true, skills });
      if (input.action === 'migrate') return send(res, 200, { ok: true, skills });
      if (input.action === 'read') {
        const skill = skills.find((item) => item.id === input.id);
        return skill
          ? send(res, 200, { ok: true, skill })
          : send(res, 404, { ok: false, error: '技能不存在' });
      }
      if (input.action === 'validate') return send(res, 200, { ok: true, errors: [] });
    }
    if (
      req.method === 'GET' &&
      ['/__tb_reqanalysis/prompt', '/__tb_storyreview/prompt', '/__tb_testpoints/prompt'].includes(
        url.pathname,
      )
    ) {
      return send(res, 200, { ok: true, exists: true });
    }
    if (url.pathname === '/__tb_requirements/list' && req.method === 'POST') {
      return send(res, 200, { ok: true, path: '.', entries: requirementEntries });
    }
    if (url.pathname === '/__tb_requirements/upload' && req.method === 'POST') {
      const input = await body(req);
      const target = String(input.name);
      const decoded = Buffer.from(String(input.contentBase64), 'base64');
      requirementEntries = requirementEntries.filter((entry) => entry.name !== target);
      requirementEntries.push({
        name: target,
        path: target,
        type: 'file',
        size: decoded.length,
      });
      return send(res, 200, { ok: true, path: target, size: decoded.length });
    }
    if (url.pathname === '/__tb_reqanalysis/sources') {
      return send(res, 200, {
        ok: true,
        files: [{ path: 'PRD.md', name: 'PRD.md', format: 'md', supported: true }],
      });
    }
    if (url.pathname === '/__tb_reqanalysis/source') {
      return send(res, 200, {
        ok: true,
        path: url.searchParams.get('path'),
        content: '# PRD\n用户提交订单后，可以查看订单状态。',
        format: 'md',
      });
    }
    if (url.pathname === '/__tb_reqanalysis/list') {
      return send(res, 200, { ok: true, docs });
    }
    if (url.pathname === '/__tb_reqanalysis/create' && req.method === 'POST') {
      const doc = saveDoc(await body(req));
      return send(res, 200, { ok: true, doc, revision: analysisRevision(doc) });
    }
    if (url.pathname === '/__tb_reqanalysis' && req.method === 'PUT') {
      const input = await body(req);
      const existing = docs.find((doc) => doc.id === input.id);
      if (!existing) return send(res, 404, { ok: false, error: '分析不存在' });
      const currentRevision = analysisRevision(existing);
      if (input.expectedRevision && input.expectedRevision !== currentRevision) {
        return send(res, 409, {
          ok: false,
          error: '需求分析已被更新，请重新读取后再修改',
          currentRevision,
          currentUpdatedAt: existing.updatedAt,
        });
      }
      const doc = saveDoc(input, existing);
      return send(res, 200, { ok: true, doc, revision: analysisRevision(doc) });
    }
    return send(res, 404, { ok: false, error: `not found: ${url.pathname}` });
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  const address = api.address();
  if (!address || typeof address === 'string') throw new Error('no api port');
  apiBase = `http://127.0.0.1:${address.port}`;

  mcp = createLanternMcpServer({ apiBase, version: 'test' });
  client = new Client({ name: 'mcp-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
});

after(async () => {
  await client?.close();
  await mcp?.close();
  await new Promise<void>((resolve) => api?.close(() => resolve()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('MCP 工具发现与需求分析读写闭环', async () => {
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name);
  for (const expected of [
    'lantern_status',
    'lantern_requirement_prepare',
    'lantern_skill_list',
    'lantern_skill_load',
    'lantern_requirement_import',
    'lantern_requirement_context',
    'lantern_requirement_analysis_save',
    'lantern_requirement_story_patch',
    'lantern_requirement_story_delete',
    'lantern_requirement_review_context',
    'lantern_requirement_review_save',
    'lantern_testpoints_context',
    'lantern_testpoints_save',
    'lantern_defect_templates',
    'lantern_defect_template_select',
    'lantern_defect_context',
    'lantern_defect_draft_save',
    'lantern_defect_submit',
    'lantern_defect_receipt',
  ]) {
    assert.ok(names.includes(expected), `missing ${expected}`);
  }

  const status = await client.callTool({ name: 'lantern_status', arguments: {} });
  assert.equal((status.structuredContent as { activeId?: string })?.activeId, 'space-1');

  const prepared = await client.callTool({
    name: 'lantern_requirement_prepare',
    arguments: {},
  });
  assert.equal((prepared.structuredContent as { changed?: boolean })?.changed, true);
  assert.equal(workflowPlugins.unrelated, true);
  const preparedAgain = await client.callTool({
    name: 'lantern_requirement_prepare',
    arguments: {},
  });
  assert.equal((preparedAgain.structuredContent as { changed?: boolean })?.changed, false);

  const enabledSkills = await client.callTool({
    name: 'lantern_skill_list',
    arguments: {},
  });
  assert.equal((enabledSkills.structuredContent as { count?: number })?.count, 4);
  const allSkills = await client.callTool({
    name: 'lantern_skill_list',
    arguments: { includeDisabled: true },
  });
  assert.equal((allSkills.structuredContent as { count?: number })?.count, 5);

  const localRequirement = path.join(tmp, '订单需求.md');
  fs.writeFileSync(localRequirement, '# 订单需求\n用户可以查看订单状态。', 'utf8');
  const imported = await client.callTool({
    name: 'lantern_requirement_import',
    arguments: { filePath: localRequirement },
  });
  assert.equal((imported.structuredContent as { sourcePath?: string })?.sourcePath, '订单需求.md');
  const importedAgain = await client.callTool({
    name: 'lantern_requirement_import',
    arguments: { filePath: localRequirement },
  });
  const importedAgainPath = (importedAgain.structuredContent as { sourcePath?: string }).sourcePath;
  assert.notEqual(importedAgainPath, '订单需求.md');
  assert.match(String(importedAgainPath), /^订单需求-\d{14}(?:-\d+)?\.md$/);

  const context = await client.callTool({
    name: 'lantern_requirement_context',
    arguments: { sourcePath: 'PRD.md' },
  });
  const contextData = context.structuredContent as {
    sourceHash?: string;
    skills?: { analysis?: { version?: number } };
  };
  assert.match(String(contextData.sourceHash), /^[a-f0-9]{64}$/);
  assert.equal(contextData.skills?.analysis?.version, 3);

  const saved = await client.callTool({
    name: 'lantern_requirement_analysis_save',
    arguments: {
      sourcePath: 'PRD.md',
      sourceHash: contextData.sourceHash,
      outline: [{ id: 'RO-1', title: '查看订单状态', quote: '可以查看订单状态' }],
      stories: [
        {
          title: '查看订单状态',
          role: '用户',
          goal: '查看订单状态',
          sourceRefs: ['RO-1'],
          priority: 'P0',
          acceptance: [{ given: '订单已提交', when: '打开详情', then: '显示最新状态' }],
        },
      ],
    },
  });
  const savedData = saved.structuredContent as {
    analysisId?: string;
    storyCount?: number;
    revision?: string;
  };
  assert.equal(savedData.storyCount, 1);
  assert.ok(savedData.analysisId);
  assert.match(String(savedData.revision), /^[a-f0-9]{64}$/);

  const reviewContext = await client.callTool({
    name: 'lantern_requirement_review_context',
    arguments: { analysisId: savedData.analysisId },
  });
  assert.equal(
    (reviewContext.structuredContent as { nextTool?: string })?.nextTool,
    'lantern_requirement_review_save',
  );
  const reviewRevision = (reviewContext.structuredContent as { revision?: string }).revision;
  const reviewSaved = await client.callTool({
    name: 'lantern_requirement_review_save',
    arguments: {
      analysisId: savedData.analysisId,
      expectedRevision: reviewRevision,
      check: {
        summary: '主流程完整',
        coverage: { total: 1, covered: 1, rate: 1 },
        gaps: [],
      },
    },
  });
  assert.equal((reviewSaved.structuredContent as { gapCount?: number })?.gapCount, 0);
  const reviewed = await client.callTool({
    name: 'lantern_requirement_analysis_get',
    arguments: { analysisId: savedData.analysisId },
  });
  const reviewedRevision = (reviewed.structuredContent as { revision?: string }).revision;

  const pointsContext = await client.callTool({
    name: 'lantern_testpoints_context',
    arguments: { analysisId: savedData.analysisId },
  });
  assert.equal(
    (pointsContext.structuredContent as { nextTool?: string })?.nextTool,
    'lantern_testpoints_save',
  );
  assert.equal(
    (pointsContext.structuredContent as { revision?: string }).revision,
    reviewedRevision,
  );
  const pointsRevision = (pointsContext.structuredContent as { revision?: string }).revision;

  const pointsSaved = await client.callTool({
    name: 'lantern_testpoints_save',
    arguments: {
      analysisId: savedData.analysisId,
      expectedRevision: pointsRevision,
      testPoints: {
        summary: '覆盖主流程',
        points: [
          {
            storyId: 'US-001',
            dimension: 'functional',
            priority: 'P0',
            title: '查看最新订单状态',
            expected: '显示最新状态',
          },
        ],
      },
    },
  });
  assert.equal((pointsSaved.structuredContent as { pointCount?: number })?.pointCount, 1);

  const afterPoints = await client.callTool({
    name: 'lantern_requirement_analysis_get',
    arguments: { analysisId: savedData.analysisId },
  });
  const afterPointsData = afterPoints.structuredContent as { revision?: string };

  const staleSource = await client.callTool({
    name: 'lantern_requirement_analysis_save',
    arguments: {
      analysisId: savedData.analysisId,
      expectedRevision: afterPointsData.revision,
      sourceHash: '0'.repeat(64),
      stories: [{ title: '不应写入', sourceRefs: ['RO-1'] }],
    },
  });
  assert.equal(staleSource.isError, true);

  const patched = await client.callTool({
    name: 'lantern_requirement_story_patch',
    arguments: {
      analysisId: savedData.analysisId,
      storyId: 'US-001',
      expectedRevision: afterPointsData.revision,
      patch: { title: '查看订单最新状态' },
    },
  });
  assert.equal(
    (patched.structuredContent as { story?: { title?: string } })?.story?.title,
    '查看订单最新状态',
  );

  const stale = await client.callTool({
    name: 'lantern_requirement_story_patch',
    arguments: {
      analysisId: savedData.analysisId,
      storyId: 'US-001',
      expectedRevision: afterPointsData.revision,
      patch: { title: '不应写入的旧修改' },
    },
  });
  assert.equal(stale.isError, true);
  assert.equal(
    (stale.structuredContent as { details?: { currentRevision?: string } })?.details
      ?.currentRevision,
    (patched.structuredContent as { revision?: string }).revision,
  );

  const beforeDelete = await client.callTool({
    name: 'lantern_requirement_analysis_get',
    arguments: { analysisId: savedData.analysisId },
  });
  const deleted = await client.callTool({
    name: 'lantern_requirement_story_delete',
    arguments: {
      analysisId: savedData.analysisId,
      storyId: 'US-001',
      expectedRevision: (beforeDelete.structuredContent as { revision?: string }).revision,
    },
  });
  assert.equal((deleted.structuredContent as { storyCount?: number })?.storyCount, 0);
  assert.equal((deleted.structuredContent as { removedPointCount?: number })?.removedPointCount, 1);
});

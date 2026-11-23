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
const externalTool = {
  name: 'mcp__tencent-docs__smartsheet_list_records',
  remoteName: 'smartsheet.list_records',
  server: 'tencent-docs',
  description: '读取腾讯文档记录',
  inputSchema: {
    type: 'object',
    properties: { file_id: { type: 'string' } },
    required: ['file_id'],
  },
  annotations: { readOnlyHint: true },
};
let externalTools = [externalTool];
let externalErrors: string[] = [];
const externalCalls: Array<Record<string, unknown>> = [];
let externalResult: Record<string, unknown> = {
  ok: true,
  content: [{ type: 'text', text: 'records' }],
};
let workflowPlugins: Record<string, boolean> = {
  requirements: false,
  reqAnalysis: false,
  reqBreakdowns: false,
  storyReview: false,
  testPoints: false,
  unrelated: true,
};
const businessStore: Record<string, any> = {
  version: 2,
  revision: 5,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  systems: [
    {
      id: 'sys_1',
      name: '工单系统',
      description: '测试系统',
      entryUrl: 'https://example.com',
      sourceDir: '',
      analysisScope: '',
      docs: { requirements: true, knowledge: false, scope: '当前系统' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
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
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      functions: [
        {
          id: 'fn_1',
          code: 'F-001',
          name: '新建工单',
          directoryId: 'dir_1',
          order: 0,
          domain: '',
          module: '',
          status: '在用',
          purpose: '登记诉求',
          roles: ['受理人员'],
          entry: '',
          inputs: [],
          outputs: [],
          rules: [],
          writes: [],
          exceptions: [],
          implementation: [],
          evidence: [{ id: 'ev_1', note: '页面证据' }],
          confidence: 'high',
          source: 'manual',
          confirmed: true,
          lockedFields: [],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      flows: [
        {
          id: 'flow_1',
          code: 'P1',
          name: '新建工单流程',
          result: '形成工单',
          status: '健康',
          steps: [
            {
              id: 'step_1',
              n: 1,
              title: '新建工单',
              role: '受理人员',
              system: '工单系统',
              functionId: 'fn_1',
              input: '',
              output: '工单',
              next: '',
              branch: '',
              branchBroken: false,
              manual: false,
              dependencies: [],
              evidence: [],
            },
          ],
          evidence: [],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      proposals: [],
    },
  ],
};
let businessAssistant: Record<string, any> = {
  phase: 'directory',
  status: 'idle',
  runId: '',
  seq: 1,
  messages: [],
  events: [{ seq: 1, type: 'status', title: '等待指令' }],
  progress: { label: '等待开始', current: 0, total: 0, percent: 0 },
  proposal: null,
  directoryApplied: true,
  flowApplied: false,
};
const businessRequests: Array<{ path: string; method: string; body: any }> = [];
let requirementBreakdownRevision = 3;
const businessLoginRequests: Array<{ action: string; body: any }> = [];
const businessMaterialRequests: Array<{
  method: string;
  name: string;
  size: number;
}> = [];
let requirementBreakdownEntries: Array<Record<string, any>> = [
  {
    id: 'rb_1',
    title: '上海12345市民服务热线V1.12_需求拆解.xmind',
    project: '上海12345市民服务热线V1.12',
    iteration: 'V1.12',
    sourcePath: '上海12345市民服务热线V1.12/需求规格说明书.docx',
    sourceTitle: '上海12345市民服务热线V1.12_需求规格说明书.docx',
    kind: 'generated',
    fileName: '上海12345市民服务热线V1.12_需求拆解.xmind',
    exists: true,
    note: '',
    createdAt: '2026-11-23T01:00:00.000Z',
    updatedAt: '2026-11-23T01:00:00.000Z',
  },
];
const defectRequests: Array<{ action: string; body: any }> = [];
let defectRule: Record<string, any> = {
  id: 'rule_1',
  name: '默认缺陷规则',
  config: { target: { platform: 'manual' }, template: '', mapping: [] },
};
let defectDraft: Record<string, any> = {
  id: 'draft_1',
  revision: 'draft-r1',
  status: 'draft',
  preview: [],
  missing: [],
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

async function rawBody(req: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
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
    if (url.pathname === '/__tb_mcp/tools') {
      return send(res, 200, {
        ok: true,
        tools: externalTools,
        connected: externalTools.length ? ['tencent-docs'] : [],
        errors: externalErrors,
      });
    }
    if (url.pathname === '/__tb_mcp/call') {
      externalCalls.push(await body(req));
      return send(res, externalResult.ok === false ? 400 : 200, externalResult);
    }
    if (url.pathname === '/__tb_config') {
      if (req.method === 'GET') {
        return send(res, 200, {
          ok: true,
          configTarget: tmp,
          config: {
            plugins: workflowPlugins,
            model: {
              activeId: 'provider-test',
              reasoningEffort: 'high',
              providers: [
                {
                  id: 'provider-test',
                  name: '测试模型',
                  baseURL: 'https://model.example/v1',
                  model: 'test-model',
                },
              ],
            },
          },
          apiKey: 'test-secret-key',
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
    if (url.pathname.startsWith('/__tb_req_breakdowns')) {
      const tail = url.pathname.slice('/__tb_req_breakdowns'.length).replace(/^\/+|\/+$/g, '');
      const parts = tail ? tail.split('/') : [];
      const input = req.method === 'GET' ? {} : await body(req);
      if (req.method === 'GET' && tail === 'list') {
        return send(res, 200, {
          ok: true,
          revision: requirementBreakdownRevision,
          entries: requirementBreakdownEntries,
        });
      }
      if (req.method === 'GET' && tail === 'backfill') {
        return send(res, 200, {
          ok: true,
          revision: requirementBreakdownRevision,
          candidates: [
            {
              analysisId: 'ra_1',
              title: '待补录需求',
              sourcePath: '项目/V1.0/待补录需求.docx',
              sourceTitle: '项目V1.0_待补录需求.docx',
              sourceExportAt: '2026-11-23T00:00:00.000Z',
              updatedAt: '2026-11-23T00:00:00.000Z',
              recorded: false,
            },
          ],
        });
      }
      if (req.method === 'GET' && parts[0] === 'entries' && parts[1]) {
        const entry = requirementBreakdownEntries.find((item) => item.id === parts[1]);
        if (!entry) return send(res, 404, { ok: false, error: '拆解条目不存在' });
        return send(res, 200, {
          ok: true,
          revision: requirementBreakdownRevision,
          entry,
          content: url.searchParams.get('includeContent')
            ? { text: '- 需求原文', tree: [{ title: '需求原文', depth: 0 }] }
            : null,
        });
      }
      if (req.method === 'POST' && tail === 'import') {
        if (input.expectedRevision !== requirementBreakdownRevision) {
          return send(res, 409, {
            ok: false,
            error: '需求拆解库已被其他页面修改，请刷新后重试',
            currentRevision: requirementBreakdownRevision,
          });
        }
        requirementBreakdownRevision += 1;
        const entry = {
          id: 'rb_import',
          title: '导入需求_需求拆解.xmind',
          project: input.project || '手动上传',
          iteration: input.iteration || 'V1.0',
          sourcePath: '',
          sourceTitle: input.name,
          kind: 'uploaded',
          fileName: '导入需求_需求拆解.xmind',
          exists: true,
          note: input.note || '',
          createdAt: '2026-11-23T02:00:00.000Z',
          updatedAt: '2026-11-23T02:00:00.000Z',
        };
        requirementBreakdownEntries.unshift(entry);
        return send(res, 200, { ok: true, revision: requirementBreakdownRevision, entry });
      }
      if (req.method === 'POST' && tail === 'backfill') {
        requirementBreakdownRevision += 1;
        return send(res, 200, {
          ok: true,
          revision: requirementBreakdownRevision,
          created: [
            {
              ...requirementBreakdownEntries[0],
              id: 'rb_backfill',
              title: '待补录需求_需求拆解.xmind',
            },
          ],
          failed: [],
        });
      }
      if (req.method === 'POST' && parts[0] === 'entries' && parts[2] === 'retry') {
        requirementBreakdownRevision += 1;
        return send(res, 200, {
          ok: true,
          revision: requirementBreakdownRevision,
          entry: requirementBreakdownEntries[0],
        });
      }
      if (req.method === 'POST' && parts[0] === 'entries' && parts[2] === 'open') {
        return send(res, 200, { ok: true });
      }
      if (req.method === 'PUT' && parts[0] === 'entries' && parts[1]) {
        requirementBreakdownRevision += 1;
        requirementBreakdownEntries = requirementBreakdownEntries.map((entry) =>
          entry.id === parts[1]
            ? {
                ...entry,
                ...(input.title ? { title: input.title } : {}),
                ...(input.note !== undefined ? { note: input.note } : {}),
              }
            : entry,
        );
        return send(res, 200, {
          ok: true,
          revision: requirementBreakdownRevision,
          entry: requirementBreakdownEntries.find((entry) => entry.id === parts[1]),
        });
      }
      if (req.method === 'DELETE' && parts[0] === 'entries' && parts[1]) {
        requirementBreakdownRevision += 1;
        requirementBreakdownEntries = requirementBreakdownEntries.filter(
          (entry) => entry.id !== parts[1],
        );
        return send(res, 200, { ok: true, revision: requirementBreakdownRevision });
      }
      return send(res, 404, { ok: false, error: `breakdown not found: ${url.pathname}` });
    }
    if (url.pathname.startsWith('/__tb_business_map')) {
      const tail = url.pathname.slice('/__tb_business_map'.length).replace(/^\/+|\/+$/g, '');
      const parts = tail ? tail.split('/') : [];
      if (parts[0] === 'systems' && parts[1] && parts[2] === 'materials') {
        const name = url.searchParams.get('name') || '';
        if (req.method === 'GET') {
          return send(res, 200, {
            ok: true,
            materials: [{ name: '现有资料.docx', size: 1024, updatedAt: '2026-01-01' }],
          });
        }
        if (req.method === 'POST') {
          const content = await rawBody(req);
          businessMaterialRequests.push({ method: 'POST', name, size: content.length });
          return send(res, 201, {
            ok: true,
            material: { name, size: content.length, updatedAt: '2026-01-01' },
          });
        }
        if (req.method === 'DELETE') {
          businessMaterialRequests.push({ method: 'DELETE', name, size: 0 });
          return send(res, 200, { ok: true });
        }
      }
      if (parts[0] === 'systems' && parts[1] && parts[2] === 'login') {
        const action = parts[3] || 'status';
        const input = req.method === 'GET' ? {} : await body(req);
        businessLoginRequests.push({ action, body: input });
        return send(res, 200, {
          ok: true,
          config: { mode: 'manual', loginUrl: 'https://example.com/login' },
          hasPassword: false,
          stateReady: action === 'complete',
          status: action === 'start' ? 'awaiting_login' : 'ready',
          message: '',
        });
      }
      const input = req.method === 'GET' ? {} : await body(req);
      businessRequests.push({ path: url.pathname, method: req.method || 'GET', body: input });
      if (req.method === 'GET' && !tail) return send(res, 200, { ok: true, store: businessStore });
      if (parts[0] === 'systems' && !parts[1] && req.method === 'POST') {
        businessStore.revision += 1;
        return send(res, 200, {
          ok: true,
          store: businessStore,
          systemId: businessStore.systems[0].id,
        });
      }
      if (parts[0] === 'systems' && parts[1] && parts.length === 2 && req.method === 'PUT') {
        businessStore.revision += 1;
        return send(res, 200, {
          ok: true,
          store: businessStore,
          systemId: parts[1],
        });
      }
      if (parts[0] === 'systems' && parts[1] && parts.length === 2 && req.method === 'DELETE') {
        businessStore.revision += 1;
        return send(res, 200, { ok: true, store: businessStore });
      }
      if (parts[2] === 'directories') {
        businessStore.revision += 1;
        if (req.method === 'DELETE') return send(res, 200, { ok: true, store: businessStore });
        return send(res, 200, {
          ok: true,
          store: businessStore,
          directory: { id: 'dir_new', name: input.directory?.name || '新目录' },
        });
      }
      if (parts[2] === 'tree' && parts[3] === 'move') {
        businessStore.revision += 1;
        return send(res, 200, { ok: true, store: businessStore });
      }
      if (parts[2] === 'functions') {
        businessStore.revision += 1;
        if (req.method === 'DELETE') return send(res, 200, { ok: true, store: businessStore });
        return send(res, 200, {
          ok: true,
          store: businessStore,
          item: { id: 'fn_new', ...input.function },
        });
      }
      if (parts[2] === 'flows') {
        businessStore.revision += 1;
        if (req.method === 'DELETE') return send(res, 200, { ok: true, store: businessStore });
        return send(res, 200, {
          ok: true,
          store: businessStore,
          item: { id: 'flow_new', ...input.flow },
        });
      }
      if (parts[2] === 'assistant') {
        if (parts[3] === 'messages') {
          businessAssistant = {
            ...businessAssistant,
            status: 'running',
            runId: 'run-1',
          };
          return send(res, 202, { ok: true, session: businessAssistant });
        }
        if (parts[3] === 'apply') {
          businessStore.revision += 1;
          businessAssistant = { ...businessAssistant, status: 'idle', proposal: null };
          return send(res, 200, {
            ok: true,
            session: businessAssistant,
            store: businessStore,
          });
        }
        if (parts[3] === 'stop' || parts[3] === 'reset') {
          businessAssistant = { ...businessAssistant, status: 'stopped' };
          return send(res, 200, { ok: true, session: businessAssistant });
        }
        return send(res, 200, { ok: true, session: businessAssistant });
      }
      return send(res, 404, { ok: false, error: `business not found: ${url.pathname}` });
    }
    if (url.pathname.startsWith('/__tb_defect_submit')) {
      const action = url.pathname.slice('/__tb_defect_submit'.length) || '/';
      const input = req.method === 'GET' ? {} : await body(req);
      defectRequests.push({ action, body: input });
      if (req.method === 'GET' && action === '/templates') {
        return send(res, 200, {
          ok: true,
          selectedId: defectRule.id,
          templates: [defectRule],
        });
      }
      if (req.method === 'GET' && action === '/context') {
        return send(res, 200, {
          ok: true,
          configured: true,
          target: { platform: 'manual', url: '' },
          template: '缺陷模板',
          fields: [
            {
              id: 'title',
              title: '缺陷标题',
              label: '缺陷标题',
              kind: 'text',
              required: true,
              options: [],
            },
          ],
          revision: 'ctx-1',
        });
      }
      if (req.method === 'GET' && action === '/drafts') {
        return send(res, 200, { ok: true, drafts: [defectDraft] });
      }
      if (req.method === 'GET' && action === '/receipt') {
        return send(res, 200, { ok: true, ...defectDraft });
      }
      if (req.method === 'POST' && action === '/inspect') {
        return send(res, 200, {
          ok: true,
          target: { platform: 'tencent', fileId: 'file_1', url: input.url },
          sheets: [{ id: 'sheet_1', title: '缺陷' }],
          sheetId: 'sheet_1',
          fields: [{ id: 'f1', title: '缺陷标题', kind: 'text', options: [] }],
        });
      }
      if (req.method === 'POST' && action === '/select-template') {
        return send(res, 200, {
          ok: true,
          configured: true,
          target: { platform: 'manual', url: '' },
          template: '缺陷模板',
          fields: [],
          revision: 'ctx-1',
        });
      }
      if (req.method === 'POST' && action === '/rules/save') {
        defectRule = {
          id: input.id || 'rule_new',
          name: input.name,
          config: {
            target: { platform: input.url ? 'tencent' : 'manual' },
            template: input.template || '',
            mapping: input.mapping,
            iterations: input.iterations || [],
            iteration: input.iteration || '',
          },
        };
        return send(res, 200, { ok: true, ...defectRule });
      }
      if (req.method === 'POST' && action === '/rules/delete') {
        return send(res, 200, { ok: true, selectedId: '', templates: [] });
      }
      if (req.method === 'POST' && action === '/draft') {
        defectDraft = {
          ...defectDraft,
          ...input,
          id: input.id || 'draft_1',
          revision: 'draft-r2',
          status: 'draft',
        };
        return send(res, 200, { ok: true, ...defectDraft });
      }
      if (req.method === 'POST' && action === '/submit') {
        defectDraft = { ...defectDraft, status: 'submitted', number: 'BUG-001' };
        return send(res, 200, { ok: true, ...defectDraft });
      }
      return send(res, 404, { ok: false, error: `defect not found: ${url.pathname}` });
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
    if (url.pathname === '/__tb_reqanalysis/delete' && req.method === 'POST') {
      const input = await body(req);
      const ids = new Set(Array.isArray(input.ids) ? input.ids.map(String) : []);
      const before = docs.length;
      docs = docs.filter((doc) => !ids.has(String(doc.id)));
      return send(res, 200, { ok: true, removed: before - docs.length });
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
    'lantern_mcp_tools',
    'lantern_mcp_call',
    'lantern_business_map_list',
    'lantern_business_map_get',
    'lantern_business_login_status',
    'lantern_business_login_start',
    'lantern_business_login_complete',
    'lantern_business_login_cancel',
    'lantern_business_material_list',
    'lantern_business_material_upload',
    'lantern_business_material_delete',
    'lantern_business_system_save',
    'lantern_business_system_delete',
    'lantern_business_directory_save',
    'lantern_business_tree_move',
    'lantern_business_directory_delete',
    'lantern_business_function_save',
    'lantern_business_function_delete',
    'lantern_business_flow_save',
    'lantern_business_flow_delete',
    'lantern_business_assistant_get',
    'lantern_business_assistant_send',
    'lantern_business_assistant_stop',
    'lantern_business_assistant_reset',
    'lantern_business_assistant_apply',
    'lantern_business_assistant_wait',
    'lantern_requirement_breakdown_list',
    'lantern_requirement_breakdown_get',
    'lantern_requirement_breakdown_import',
    'lantern_requirement_breakdown_backfill_candidates',
    'lantern_requirement_breakdown_record_analysis',
    'lantern_requirement_breakdown_retry',
    'lantern_requirement_breakdown_update',
    'lantern_requirement_breakdown_open',
    'lantern_requirement_breakdown_delete',
    'lantern_requirement_prepare',
    'lantern_skill_list',
    'lantern_skill_load',
    'lantern_requirement_import',
    'lantern_requirement_context',
    'lantern_requirement_analysis_list',
    'lantern_requirement_analysis_delete',
    'lantern_requirement_analysis_save',
    'lantern_requirement_story_patch',
    'lantern_requirement_story_delete',
    'lantern_requirement_review_context',
    'lantern_requirement_review_save',
    'lantern_testpoints_context',
    'lantern_testpoints_save',
    'lantern_defect_templates',
    'lantern_defect_rule_inspect',
    'lantern_defect_rule_save',
    'lantern_defect_rule_delete',
    'lantern_defect_drafts',
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
  const spaces = await client.callTool({ name: 'lantern_space_list', arguments: {} });
  assert.equal((spaces.structuredContent as { activeId?: string })?.activeId, 'space-1');
  const requirementList = await client.callTool({
    name: 'lantern_requirement_list',
    arguments: {},
  });
  assert.ok(Array.isArray((requirementList.structuredContent as { entries?: unknown[] })?.entries));
  const requirementSources = await client.callTool({
    name: 'lantern_requirement_sources',
    arguments: {},
  });
  assert.ok(Array.isArray((requirementSources.structuredContent as { files?: unknown[] })?.files));

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
  const validation = await client.callTool({
    name: 'lantern_skill_validate',
    arguments: { id: 'requirements-1', input: { rows: [] } },
  });
  assert.deepEqual((validation.structuredContent as { errors?: unknown[] })?.errors, []);

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

  const analyses = await client.callTool({
    name: 'lantern_requirement_analysis_list',
    arguments: { query: 'PRD' },
  });
  assert.equal((analyses.structuredContent as { count?: number })?.count, 1);
  assert.equal(
    (analyses.structuredContent as { analyses?: Array<{ id?: string }> })?.analyses?.[0]?.id,
    savedData.analysisId,
  );
  const deletedAnalysis = await client.callTool({
    name: 'lantern_requirement_analysis_delete',
    arguments: { analysisIds: [savedData.analysisId] },
  });
  assert.equal((deletedAnalysis.structuredContent as { removed?: number })?.removed, 1);
});

test('业务地图 MCP 支持读取、CRUD 与 AI 会话控制', async () => {
  const listedMap = await client.callTool({
    name: 'lantern_business_map_list',
    arguments: {},
  });
  assert.equal((listedMap.structuredContent as { revision?: number })?.revision, 5);
  assert.equal((listedMap.structuredContent as { systems?: unknown[] })?.systems?.length, 1);

  const detailed = await client.callTool({
    name: 'lantern_business_map_get',
    arguments: { systemId: 'sys_1', functionId: 'fn_1' },
  });
  const detailedData = detailed.structuredContent as {
    revision?: number;
    functions?: Array<{ id?: string; evidence?: unknown[] }>;
  };
  assert.equal(detailedData.revision, 5);
  assert.equal(detailedData.functions?.[0]?.id, 'fn_1');
  assert.equal(detailedData.functions?.[0]?.evidence, undefined);

  const loginStatus = await client.callTool({
    name: 'lantern_business_login_status',
    arguments: { systemId: 'sys_1' },
  });
  assert.equal(
    (loginStatus.structuredContent as { config?: { mode?: string } })?.config?.mode,
    'manual',
  );
  const loginStarted = await client.callTool({
    name: 'lantern_business_login_start',
    arguments: { systemId: 'sys_1', manual: true },
  });
  assert.equal((loginStarted.structuredContent as { status?: string })?.status, 'awaiting_login');
  const loginCompleted = await client.callTool({
    name: 'lantern_business_login_complete',
    arguments: { systemId: 'sys_1' },
  });
  assert.equal((loginCompleted.structuredContent as { stateReady?: boolean })?.stateReady, true);
  await client.callTool({
    name: 'lantern_business_login_cancel',
    arguments: { systemId: 'sys_1' },
  });
  assert.deepEqual(
    businessLoginRequests.map((item) => item.action),
    ['status', 'start', 'complete', 'cancel'],
  );

  const materials = await client.callTool({
    name: 'lantern_business_material_list',
    arguments: { systemId: 'sys_1' },
  });
  assert.equal(
    (materials.structuredContent as { materials?: Array<{ name?: string }> })?.materials?.[0]?.name,
    '现有资料.docx',
  );
  const localMaterial = path.join(tmp, '补充资料.xlsx');
  fs.writeFileSync(localMaterial, Buffer.from('fixture-material'));
  const uploadedMaterial = await client.callTool({
    name: 'lantern_business_material_upload',
    arguments: { systemId: 'sys_1', filePath: localMaterial },
  });
  assert.equal(
    (uploadedMaterial.structuredContent as { material?: { name?: string } })?.material?.name,
    '补充资料.xlsx',
  );
  await client.callTool({
    name: 'lantern_business_material_delete',
    arguments: { systemId: 'sys_1', name: '补充资料.xlsx' },
  });
  assert.deepEqual(
    businessMaterialRequests.map((item) => [item.method, item.name, item.size]),
    [
      ['POST', '补充资料.xlsx', Buffer.byteLength('fixture-material')],
      ['DELETE', '补充资料.xlsx', 0],
    ],
  );

  const savedSystem = await client.callTool({
    name: 'lantern_business_system_save',
    arguments: {
      expectedRevision: businessStore.revision,
      systemId: 'sys_1',
      name: '工单系统（更新）',
    },
  });
  assert.equal((savedSystem.structuredContent as { revision?: number })?.revision, 6);

  const missingRevision = await client.callTool({
    name: 'lantern_business_directory_save',
    arguments: { systemId: 'sys_1', name: '不应创建' },
  });
  assert.equal(missingRevision.isError, true);
  assert.equal(
    (missingRevision.structuredContent as { details?: { currentRevision?: number } })?.details
      ?.currentRevision,
    6,
  );

  const savedDirectory = await client.callTool({
    name: 'lantern_business_directory_save',
    arguments: {
      expectedRevision: businessStore.revision,
      systemId: 'sys_1',
      name: '派单管理',
      parentId: '',
    },
  });
  assert.equal(
    (savedDirectory.structuredContent as { directory?: { id?: string } })?.directory?.id,
    'dir_new',
  );

  const moved = await client.callTool({
    name: 'lantern_business_tree_move',
    arguments: {
      expectedRevision: businessStore.revision,
      systemId: 'sys_1',
      kind: 'function',
      id: 'fn_1',
      parentId: 'dir_new',
    },
  });
  assert.notEqual(moved.isError, true);

  const deletedDirectory = await client.callTool({
    name: 'lantern_business_directory_delete',
    arguments: {
      expectedRevision: businessStore.revision,
      systemId: 'sys_1',
      directoryId: 'dir_new',
      cascade: true,
    },
  });
  assert.notEqual(deletedDirectory.isError, true);

  const savedFunction = await client.callTool({
    name: 'lantern_business_function_save',
    arguments: {
      expectedRevision: businessStore.revision,
      systemId: 'sys_1',
      name: '派单',
      directoryId: 'dir_1',
      purpose: '把工单派给承办单位',
    },
  });
  assert.equal(
    (savedFunction.structuredContent as { item?: { name?: string } })?.item?.name,
    '派单',
  );

  const deletedFunction = await client.callTool({
    name: 'lantern_business_function_delete',
    arguments: {
      expectedRevision: businessStore.revision,
      systemId: 'sys_1',
      functionId: 'fn_new',
    },
  });
  assert.notEqual(deletedFunction.isError, true);

  const savedFlow = await client.callTool({
    name: 'lantern_business_flow_save',
    arguments: {
      expectedRevision: businessStore.revision,
      systemId: 'sys_1',
      name: '派单流程',
      steps: [
        {
          title: '执行派单',
          functionId: 'fn_1',
          role: '调度人员',
        },
      ],
    },
  });
  assert.equal(
    (savedFlow.structuredContent as { item?: { name?: string } })?.item?.name,
    '派单流程',
  );

  const deletedFlow = await client.callTool({
    name: 'lantern_business_flow_delete',
    arguments: {
      expectedRevision: businessStore.revision,
      systemId: 'sys_1',
      flowId: 'flow_new',
    },
  });
  assert.notEqual(deletedFlow.isError, true);

  businessAssistant = {
    ...businessAssistant,
    status: 'awaiting_confirmation',
    events: [
      { seq: 1, type: 'status', title: '旧事件' },
      { seq: 2, type: 'proposal', title: '草案已生成' },
    ],
  };
  const assistant = await client.callTool({
    name: 'lantern_business_assistant_get',
    arguments: { systemId: 'sys_1', afterSeq: 1 },
  });
  assert.deepEqual(
    (assistant.structuredContent as { session?: { events?: unknown[] } })?.session?.events,
    [{ seq: 2, type: 'proposal', title: '草案已生成' }],
  );

  const sent = await client.callTool({
    name: 'lantern_business_assistant_send',
    arguments: {
      expectedRevision: businessStore.revision,
      systemId: 'sys_1',
      phase: 'directory',
      message: '识别功能目录',
    },
  });
  assert.equal(
    (sent.structuredContent as { session?: { status?: string } })?.session?.status,
    'running',
  );
  const sendRequest = businessRequests
    .filter((item) => item.path.endsWith('/assistant/messages'))
    .at(-1);
  assert.deepEqual(sendRequest?.body.settings, {
    baseURL: 'https://model.example/v1',
    model: 'test-model',
    apiKey: 'test-secret-key',
    reasoningEffort: 'high',
  });
  assert.doesNotMatch(JSON.stringify(sent.content), /test-secret-key/);

  const stopped = await client.callTool({
    name: 'lantern_business_assistant_stop',
    arguments: { systemId: 'sys_1' },
  });
  assert.notEqual(stopped.isError, true);
  const reset = await client.callTool({
    name: 'lantern_business_assistant_reset',
    arguments: { systemId: 'sys_1' },
  });
  assert.notEqual(reset.isError, true);

  const applied = await client.callTool({
    name: 'lantern_business_assistant_apply',
    arguments: {
      expectedRevision: businessStore.revision,
      systemId: 'sys_1',
    },
  });
  assert.notEqual(applied.isError, true);

  businessAssistant = { ...businessAssistant, status: 'awaiting_confirmation' };
  const waited = await client.callTool({
    name: 'lantern_business_assistant_wait',
    arguments: { systemId: 'sys_1', timeoutMs: 1000, afterSeq: 0 },
  });
  assert.equal(
    (waited.structuredContent as { session?: { status?: string } })?.session?.status,
    'awaiting_confirmation',
  );

  const deletedSystem = await client.callTool({
    name: 'lantern_business_system_delete',
    arguments: {
      expectedRevision: businessStore.revision,
      systemId: 'sys_1',
    },
  });
  assert.notEqual(deletedSystem.isError, true);
});

test('缺陷规则与草稿 MCP 形成可核验闭环', async () => {
  const inspected = await client.callTool({
    name: 'lantern_defect_rule_inspect',
    arguments: { url: 'https://docs.qq.com/smartsheet/file_1?tab=sheet_1' },
  });
  assert.equal(
    (inspected.structuredContent as { fields?: Array<{ id?: string }> })?.fields?.[0]?.id,
    'f1',
  );

  const savedRule = await client.callTool({
    name: 'lantern_defect_rule_save',
    arguments: {
      id: 'rule_1',
      name: '缺陷规则',
      url: 'https://docs.qq.com/smartsheet/file_1',
      sheetId: 'sheet_1',
      mapping: [
        {
          id: 'f1',
          label: '缺陷标题',
          required: true,
          source: 'remote',
          rule: '提取问题摘要',
        },
      ],
      iterations: ['V1.12'],
      iteration: 'V1.12',
    },
  });
  assert.equal((savedRule.structuredContent as { name?: string })?.name, '缺陷规则');

  const templates = await client.callTool({
    name: 'lantern_defect_templates',
    arguments: {},
  });
  assert.equal((templates.structuredContent as { selectedId?: string })?.selectedId, 'rule_1');
  const context = await client.callTool({
    name: 'lantern_defect_context',
    arguments: {},
  });
  assert.equal((context.structuredContent as { fields?: unknown[] })?.fields?.length, 1);
  const selected = await client.callTool({
    name: 'lantern_defect_template_select',
    arguments: { id: 'rule_1' },
  });
  assert.equal((selected.structuredContent as { revision?: string })?.revision, 'ctx-1');

  const initialDrafts = await client.callTool({
    name: 'lantern_defect_drafts',
    arguments: {},
  });
  assert.equal(
    (initialDrafts.structuredContent as { drafts?: Array<{ id?: string }> })?.drafts?.[0]?.id,
    'draft_1',
  );
  const draft = await client.callTool({
    name: 'lantern_defect_draft_save',
    arguments: {
      contextRevision: 'ctx-1',
      values: { title: '提交按钮无响应' },
    },
  });
  assert.equal((draft.structuredContent as { revision?: string })?.revision, 'draft-r2');
  const submitted = await client.callTool({
    name: 'lantern_defect_submit',
    arguments: { id: 'draft_1', revision: 'draft-r2' },
  });
  assert.equal((submitted.structuredContent as { status?: string })?.status, 'submitted');
  const receipt = await client.callTool({
    name: 'lantern_defect_receipt',
    arguments: { id: 'draft_1' },
  });
  assert.equal((receipt.structuredContent as { number?: string })?.number, 'BUG-001');

  const deletedRule = await client.callTool({
    name: 'lantern_defect_rule_delete',
    arguments: { id: 'rule_1' },
  });
  assert.deepEqual((deletedRule.structuredContent as { templates?: unknown[] })?.templates, []);
});

test('需求拆解库 MCP 支持读取、导入、补录、修改、打开和删除', async () => {
  requirementBreakdownRevision = 3;
  requirementBreakdownEntries = requirementBreakdownEntries.filter((entry) => entry.id === 'rb_1');

  const listed = await client.callTool({
    name: 'lantern_requirement_breakdown_list',
    arguments: { query: '市民服务热线', kind: 'generated' },
  });
  assert.equal((listed.structuredContent as { revision?: number }).revision, 3);
  assert.equal((listed.structuredContent as { count?: number }).count, 1);

  const loaded = await client.callTool({
    name: 'lantern_requirement_breakdown_get',
    arguments: { entryId: 'rb_1', includeContent: true },
  });
  assert.match(
    JSON.stringify((loaded.structuredContent as { content?: unknown }).content),
    /需求原文/,
  );

  const missingRevision = await client.callTool({
    name: 'lantern_requirement_breakdown_import',
    arguments: { filePath: '/tmp/not-used.xmind' },
  });
  assert.equal(missingRevision.isError, true);
  assert.equal(
    (missingRevision.structuredContent as { details?: { currentRevision?: number } }).details
      ?.currentRevision,
    3,
  );

  const input = path.join(tmp, '人工整理.xmind');
  fs.writeFileSync(input, Buffer.from('test-xmind'));
  const imported = await client.callTool({
    name: 'lantern_requirement_breakdown_import',
    arguments: {
      filePath: input,
      expectedRevision: 3,
      project: '客服项目',
      iteration: 'V1.0',
      note: '人工导入',
    },
  });
  assert.notEqual(imported.isError, true);
  assert.equal((imported.structuredContent as { revision?: number }).revision, 4);

  const updated = await client.callTool({
    name: 'lantern_requirement_breakdown_update',
    arguments: {
      entryId: 'rb_import',
      expectedRevision: 4,
      title: '导入需求_需求拆解.xmind',
      note: '已校验',
    },
  });
  assert.equal((updated.structuredContent as { entry?: { note?: string } }).entry?.note, '已校验');
  assert.equal((updated.structuredContent as { revision?: number }).revision, 5);

  const candidates = await client.callTool({
    name: 'lantern_requirement_breakdown_backfill_candidates',
    arguments: {},
  });
  assert.equal(
    (candidates.structuredContent as { candidates?: Array<{ analysisId?: string }> })
      .candidates?.[0]?.analysisId,
    'ra_1',
  );

  const backfilled = await client.callTool({
    name: 'lantern_requirement_breakdown_record_analysis',
    arguments: { analysisIds: ['ra_1'], expectedRevision: 5 },
  });
  assert.equal((backfilled.structuredContent as { revision?: number }).revision, 6);

  const retried = await client.callTool({
    name: 'lantern_requirement_breakdown_retry',
    arguments: { entryId: 'rb_import', expectedRevision: 6 },
  });
  assert.equal((retried.structuredContent as { revision?: number }).revision, 7);

  const opened = await client.callTool({
    name: 'lantern_requirement_breakdown_open',
    arguments: { entryId: 'rb_import' },
  });
  assert.notEqual(opened.isError, true);

  const deleted = await client.callTool({
    name: 'lantern_requirement_breakdown_delete',
    arguments: { entryId: 'rb_import', expectedRevision: 7 },
  });
  assert.equal((deleted.structuredContent as { revision?: number }).revision, 8);
});

test('外接 MCP 发现返回真实名称、参数和部分连接失败信息', async () => {
  externalErrors = ['other: connection refused'];
  try {
    const result = await client.callTool({
      name: 'lantern_mcp_tools',
      arguments: { server: 'tencent-docs', query: '记录' },
    });
    const data = result.structuredContent as { tools: unknown[]; errors: string[]; count: number };
    assert.deepEqual(data.tools, [externalTool]);
    assert.equal(data.count, 1);
    assert.deepEqual(data.errors, externalErrors);
    const empty = await client.callTool({
      name: 'lantern_mcp_tools',
      arguments: { server: 'unconfigured' },
    });
    assert.equal((empty.structuredContent as { count: number }).count, 0);
    const listed = await client.listTools();
    assert.equal(
      listed.tools.find((t) => t.name === 'lantern_mcp_call')?.annotations?.readOnlyHint,
      false,
    );
  } finally {
    externalErrors = [];
  }
});

test('外接 MCP 调用完整保留长文本、图片、结构化结果和参数', async () => {
  const content = [
    { type: 'text', text: 'x'.repeat(90_000) },
    { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
  ];
  externalResult = { ok: true, content, structuredContent: { records: [{ record_id: 'r123' }] } };
  const result = await client.callTool({
    name: 'lantern_mcp_call',
    arguments: { name: externalTool.name, arguments: { file_id: 'document-2', offset: 30 } },
  });
  assert.deepEqual(result.content, content);
  assert.deepEqual(result.structuredContent, externalResult.structuredContent);
  assert.equal(result.isError, false);
  assert.deepEqual(externalCalls.at(-1), {
    name: externalTool.name,
    arguments: { file_id: 'document-2', offset: 30 },
  });
});

test('切换空间或移除工具后拒绝旧工具，不转发也不重试', async () => {
  const count = externalCalls.length;
  externalTools = [];
  try {
    const result = await client.callTool({
      name: 'lantern_mcp_call',
      arguments: { name: externalTool.name },
    });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /当前空间没有这个 MCP 工具/);
    assert.equal(externalCalls.length, count);
  } finally {
    externalTools = [externalTool];
  }
});

test('外接 MCP 原样返回远端业务错误，连接失败也不伪装成功', async () => {
  externalResult = {
    ok: false,
    isError: true,
    content: [{ type: 'text', text: 'permission denied' }],
    structuredContent: { code: 403 },
  };
  const count = externalCalls.length;
  const result = await client.callTool({
    name: 'lantern_mcp_call',
    arguments: { name: externalTool.name },
  });
  assert.equal(result.isError, true);
  assert.deepEqual(result.content, externalResult.content);
  assert.deepEqual(result.structuredContent, { code: 403 });
  assert.equal(externalCalls.length, count + 1);
  externalResult = { ok: false, error: 'mcp server not connected: tencent-docs' };
  const failed = await client.callTool({
    name: 'lantern_mcp_call',
    arguments: { name: externalTool.name },
  });
  assert.equal(failed.isError, true);
  assert.match(JSON.stringify(failed.content), /not connected/);
});

test('兼容尚未更新的 Lantern HTTP 服务文本结果', async () => {
  externalResult = { ok: true, text: '{"records":[]}', isError: false };
  const result = await client.callTool({
    name: 'lantern_mcp_call',
    arguments: { name: externalTool.name },
  });
  assert.deepEqual(result.content, [{ type: 'text', text: '{"records":[]}' }]);
  assert.equal(result.isError, false);
});

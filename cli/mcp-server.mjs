/**
 * Lantern MCP Bridge：让 Codex 通过结构化工具读写当前 Lantern 数据空间。
 *
 * 首版采用委托分析模式：
 * - Codex 负责模型推理；
 * - Lantern 提供技能正文、需求源文、存储、编号、校验与 revision；
 * - Bridge 不直接改 JSON，所有写入都走现有 HTTP API。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';

import { DEFECT_API } from '../lh-plugins/lh-defect-submit.mjs';
import { analysisRevision } from '../lh-plugins/req-analysis-revision.mjs';
import { startLocalServer } from './server.mjs';

const API_PREFIX = '/__tb_';
const DOC_API = `${API_PREFIX}requirements`;
const REQ_API = `${API_PREFIX}reqanalysis`;
const SKILL_API = `${API_PREFIX}fs/skill-store`;
const CONFIG_API = `/${API_PREFIX.slice(1)}config`;
const BUSINESS_MAP_API = `/${API_PREFIX.slice(1)}business_map`;
const REQ_BREAKDOWN_API = `/${API_PREFIX.slice(1)}req_breakdowns`;
const CASE_EXECUTION_API = `/${API_PREFIX.slice(1)}case_run`;
const UI_AUTO_API = `/${API_PREFIX.slice(1)}uiauto`;
const CASE_AUTOMATION_API = `/${API_PREFIX.slice(1)}case_automation`;
const SKILL_PROMPT_ROUTES = {
  '需求分析提示词.md': `/${API_PREFIX.slice(1)}reqanalysis/prompt`,
  '原文结构提示词.md': `/${API_PREFIX.slice(1)}reqanalysis/prompt`,
  '用户故事审查提示词.md': `/${API_PREFIX.slice(1)}storyreview/prompt`,
  '测试点生成提示词.md': `/${API_PREFIX.slice(1)}testpoints/prompt`,
};
const REQUIREMENT_WORKFLOW_PLUGINS = ['requirements', 'reqAnalysis', 'storyReview', 'testPoints'];
const ALLOWED_REQUIREMENT_EXT = new Set(['.md', '.txt', '.docx', '.csv', '.xlsx', '.xls']);
const MAX_IMPORT_BYTES = 12 * 1024 * 1024;
const MAX_BUSINESS_MATERIAL_BYTES = 25 * 1024 * 1024;
const DEFAULT_SOURCE_CHARS = 80_000;
const businessEvidenceInput = z.array(z.record(z.string(), z.unknown())).optional();
const businessDependencyInput = z
  .array(
    z.object({
      system: z.string(),
      label: z.string().optional(),
    }),
  )
  .optional();

class BridgeError extends Error {
  constructor(message, status = 0, details = null) {
    super(message);
    this.name = 'BridgeError';
    this.status = status;
    this.details = details;
  }
}

function cleanBase(value) {
  return String(value || '')
    .replace(/\/+$/, '')
    .trim();
}

function sha256(text) {
  return crypto
    .createHash('sha256')
    .update(String(text ?? ''), 'utf8')
    .digest('hex');
}

function safeJsonParse(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

async function apiRequest(
  apiBase,
  route,
  {
    method = 'GET',
    body,
    rawBody,
    contentType = 'application/json',
    timeoutMs = 30_000,
    raw = false,
  } = {},
) {
  const url = `${cleanBase(apiBase)}${route}`;
  const hasBody = body !== undefined || rawBody !== undefined;
  const response = await fetch(url, {
    method,
    headers: hasBody ? { 'Content-Type': contentType } : undefined,
    body: rawBody !== undefined ? rawBody : body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  const data = raw ? text : safeJsonParse(text, { raw: text });
  if (!response.ok || (data && typeof data === 'object' && data.ok === false)) {
    const message =
      data && typeof data === 'object' && 'error' in data
        ? String(data.error)
        : `Lantern HTTP ${response.status}`;
    throw new BridgeError(message, response.status, data);
  }
  return data;
}

function toolResult(data, summary = '') {
  const structured =
    data && typeof data === 'object' && !Array.isArray(data) ? data : { value: data };
  const json = JSON.stringify(structured, null, 2);
  return {
    content: [{ type: 'text', text: summary ? `${summary}\n\n${json}` : json }],
    structuredContent: structured,
  };
}

function toolError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const details =
    error instanceof BridgeError && error.details ? { details: error.details } : undefined;
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ ok: false, error: message, ...details }) }],
    structuredContent: { ok: false, error: message, ...details },
  };
}

function protectedTool(handler) {
  return async (args, extra) => {
    try {
      return await handler(args, extra);
    } catch (error) {
      return toolError(error);
    }
  };
}

async function loadBusinessMapStore(apiBase) {
  const data = await apiRequest(apiBase, BUSINESS_MAP_API);
  if (!data.store || !Array.isArray(data.store.systems))
    throw new BridgeError('Lantern 业务地图数据不可用', 502);
  return data.store;
}

async function requireBusinessMapRevision(apiBase, expectedRevision) {
  if (Number.isFinite(Number(expectedRevision)) && Number(expectedRevision) >= 0)
    return Number(expectedRevision);
  const store = await loadBusinessMapStore(apiBase);
  throw new BridgeError('修改业务地图必须提供 expectedRevision；请先读取最新 map', 428, {
    currentRevision: store.revision,
  });
}

function requireBusinessSystem(store, systemId) {
  const system = store.systems.find((item) => item.id === systemId);
  if (!system) throw new BridgeError(`业务系统不存在：${systemId}`, 404);
  return system;
}

function businessMapSummary(store) {
  return {
    ok: true,
    revision: store.revision,
    updatedAt: store.updatedAt || '',
    systems: store.systems.map((system) => ({
      id: system.id,
      name: system.name,
      description: system.description || '',
      entryUrl: system.entryUrl || '',
      sourceDir: system.sourceDir || '',
      directoryCount: system.directories.length,
      functionCount: system.functions.length,
      flowCount: system.flows.length,
      updatedAt: system.updatedAt || '',
    })),
  };
}

function stripBusinessEvidence(item, includeEvidence) {
  if (includeEvidence || !item || typeof item !== 'object') return item;
  const { evidence: _evidence, ...rest } = item;
  return rest;
}

function projectBusinessSystem(system, args) {
  const includeEvidence = args.includeEvidence === true;
  const query = String(args.query || '')
    .trim()
    .toLowerCase();
  let directories = [...system.directories];
  let functions = [...system.functions];
  let flows = [...system.flows];

  if (args.directoryId) {
    const directoryIds = new Set([args.directoryId]);
    const queue = [args.directoryId];
    while (queue.length) {
      const parentId = queue.shift();
      for (const directory of directories) {
        if (directory.parentId === parentId && !directoryIds.has(directory.id)) {
          directoryIds.add(directory.id);
          queue.push(directory.id);
        }
      }
    }
    directories = directories.filter((directory) => directoryIds.has(directory.id));
    functions = functions.filter((fn) => directoryIds.has(fn.directoryId));
    flows = flows.filter((flow) =>
      flow.steps.some((step) => functions.some((fn) => fn.id === step.functionId)),
    );
  }

  if (args.functionId) {
    functions = functions.filter((fn) => fn.id === args.functionId);
    const functionIds = new Set(functions.map((fn) => fn.id));
    flows = flows.filter((flow) => flow.steps.some((step) => functionIds.has(step.functionId)));
  }

  if (args.flowId) {
    flows = flows.filter((flow) => flow.id === args.flowId);
    const functionIds = new Set(flows.flatMap((flow) => flow.steps.map((step) => step.functionId)));
    if (functionIds.size) functions = functions.filter((fn) => functionIds.has(fn.id));
  }

  if (query) {
    directories = directories.filter((directory) =>
      [directory.name, ...(directory.menuPath || [])].join(' ').toLowerCase().includes(query),
    );
    functions = functions.filter((fn) =>
      [fn.id, fn.code, fn.name, fn.purpose, fn.entry, fn.domain, fn.module, ...(fn.roles || [])]
        .join(' ')
        .toLowerCase()
        .includes(query),
    );
    flows = flows.filter((flow) =>
      [flow.id, flow.code, flow.name, flow.result].join(' ').toLowerCase().includes(query),
    );
  }

  return {
    system: {
      id: system.id,
      name: system.name,
      description: system.description || '',
      entryUrl: system.entryUrl || '',
      sourceDir: system.sourceDir || '',
      analysisScope: system.analysisScope || '',
      docs: system.docs,
      createdAt: system.createdAt,
      updatedAt: system.updatedAt,
    },
    directories: directories.map((item) => stripBusinessEvidence(item, includeEvidence)),
    functions: functions.map((item) => stripBusinessEvidence(item, includeEvidence)),
    flows: flows.map((flow) => ({
      ...stripBusinessEvidence(flow, includeEvidence),
      steps: flow.steps.map((step) => stripBusinessEvidence(step, includeEvidence)),
    })),
  };
}

async function loadBusinessModelSettings(apiBase) {
  const data = await apiRequest(apiBase, CONFIG_API);
  const config = data.config && typeof data.config === 'object' ? data.config : {};
  const modelConfig = config.model && typeof config.model === 'object' ? config.model : {};
  const providers = Array.isArray(modelConfig.providers) ? modelConfig.providers : [];
  const provider =
    providers.find((item) => item.id === modelConfig.activeId) || providers[0] || modelConfig;
  const settings = {
    baseURL: String(provider.baseURL || '').trim(),
    model: String(provider.model || '').trim(),
    apiKey: String(data.apiKey || provider.apiKey || '').trim(),
    ...(modelConfig.reasoningEffort
      ? { reasoningEffort: String(modelConfig.reasoningEffort) }
      : {}),
  };
  if (!settings.baseURL || !settings.model || !settings.apiKey) {
    throw new BridgeError('请先在 Lantern 设置中配置可用的模型与 API Key', 400);
  }
  return settings;
}

async function waitForBusinessAssistant(apiBase, systemId, timeoutMs, afterSeq = 0) {
  const deadline = Date.now() + Math.max(1000, Math.min(Number(timeoutMs) || 25_000, 55_000));
  let latest = null;
  while (Date.now() < deadline) {
    const data = await apiRequest(
      apiBase,
      `${BUSINESS_MAP_API}/systems/${encodeURIComponent(systemId)}/assistant`,
    );
    latest = data.session;
    if (latest?.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!latest) {
    const data = await apiRequest(
      apiBase,
      `${BUSINESS_MAP_API}/systems/${encodeURIComponent(systemId)}/assistant`,
    );
    latest = data.session;
  }
  return {
    ok: true,
    session: {
      ...latest,
      events: (latest?.events || []).filter(
        (event) => Number(event.seq) > Math.max(0, Number(afterSeq) || 0),
      ),
    },
  };
}

async function waitForCaseExecution(apiBase, runId, timeoutMs, afterSeq = 0) {
  const deadline = Date.now() + Math.max(1000, Math.min(Number(timeoutMs) || 25_000, 55_000));
  let latest = null;
  while (Date.now() < deadline) {
    const data = await apiRequest(
      apiBase,
      `${CASE_EXECUTION_API}/runs/${encodeURIComponent(runId)}`,
    );
    latest = data.run;
    if (latest?.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!latest) {
    const data = await apiRequest(
      apiBase,
      `${CASE_EXECUTION_API}/runs/${encodeURIComponent(runId)}`,
    );
    latest = data.run;
  }
  return {
    ok: true,
    run: {
      ...latest,
      events: (latest?.events || []).filter(
        (event) => Number(event.seq) > Math.max(0, Number(afterSeq) || 0),
      ),
    },
  };
}

async function waitForCaseAutomationBatch(apiBase, batchId, timeoutMs) {
  const deadline = Date.now() + Math.max(1000, Math.min(Number(timeoutMs) || 25_000, 55_000));
  let latest = null;
  while (Date.now() < deadline) {
    const data = await apiRequest(
      apiBase,
      `${CASE_AUTOMATION_API}/runs/${encodeURIComponent(batchId)}`,
    );
    latest = data.batch;
    if (!['pending', 'running'].includes(latest?.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!latest) {
    const data = await apiRequest(
      apiBase,
      `${CASE_AUTOMATION_API}/runs/${encodeURIComponent(batchId)}`,
    );
    latest = data.batch;
  }
  return { ok: true, batch: latest };
}

async function loadRequirementBreakdownList(apiBase) {
  const data = await apiRequest(apiBase, `${REQ_BREAKDOWN_API}/list`);
  if (!Array.isArray(data.entries)) throw new BridgeError('需求拆解库数据不可用', 502);
  return { revision: Number(data.revision) || 0, entries: data.entries };
}

async function requireRequirementBreakdownRevision(apiBase, expectedRevision) {
  if (Number.isFinite(Number(expectedRevision)) && Number(expectedRevision) >= 0)
    return Number(expectedRevision);
  const data = await loadRequirementBreakdownList(apiBase);
  throw new BridgeError('修改需求拆解库必须提供 expectedRevision', 428, {
    currentRevision: data.revision,
  });
}

function parseBridgeArgs(argv = []) {
  const out = { url: '', dataRoot: '', port: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--url') out.url = String(argv[++i] || '');
    else if (value.startsWith('--url=')) out.url = value.slice('--url='.length);
    else if (value === '--data-root') out.dataRoot = String(argv[++i] || '');
    else if (value.startsWith('--data-root=')) out.dataRoot = value.slice('--data-root='.length);
    else if (value === '--port') out.port = Number(argv[++i]) || 0;
    else if (value.startsWith('--port=')) out.port = Number(value.slice('--port='.length)) || 0;
  }
  return out;
}

async function probeLantern(apiBase) {
  try {
    const data = await apiRequest(apiBase, `/${API_PREFIX.slice(1)}spaces`, {
      timeoutMs: 1500,
    });
    return data && typeof data === 'object' && Array.isArray(data.spaces);
  } catch {
    return false;
  }
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function ensureLanternApi({ url = '', dataRoot, port = 0 }) {
  const requested = cleanBase(url);
  if (requested) {
    if (!(await probeLantern(requested))) {
      throw new Error(`无法连接 Lantern 服务：${requested}`);
    }
    return { apiBase: requested, localServer: null };
  }

  const defaultBase = `http://127.0.0.1:${Number(port) || 4321}`;
  if (await probeLantern(defaultBase)) {
    return { apiBase: defaultBase, localServer: null };
  }

  if (!dataRoot) throw new Error('没有可用的 Lantern 服务，也没有配置数据池根');
  const chosenPort = Number(port) || (await freePort());
  const started = await startLocalServer({
    dataRoot,
    host: '127.0.0.1',
    port: chosenPort,
  });
  return {
    apiBase: cleanBase(started.url),
    localServer: started.server,
  };
}

async function listSpaceSkills(apiBase) {
  const data = await apiRequest(apiBase, SKILL_API, {
    method: 'POST',
    body: { action: 'list' },
  });
  return Array.isArray(data.skills) ? data.skills : [];
}

async function readSpaceSkill(apiBase, id) {
  const data = await apiRequest(apiBase, SKILL_API, {
    method: 'POST',
    body: { action: 'read', id: String(id || '').replace(/^space:/, '') },
  });
  return data.skill;
}

async function findSpaceSkillByLegacy(apiBase, legacyPath, { includeDisabled = false } = {}) {
  const skills = await listSpaceSkills(apiBase);
  return (
    skills.find(
      (item) => item.legacyPath === legacyPath && (includeDisabled || item.active !== false),
    ) || null
  );
}

async function requirementDocs(apiBase) {
  const data = await apiRequest(apiBase, `/${REQ_API.slice(1)}/list`);
  return Array.isArray(data.docs) ? data.docs : [];
}

async function findAnalysis(apiBase, { analysisId, sourcePath }) {
  const docs = await requirementDocs(apiBase);
  if (analysisId) return docs.find((doc) => doc.id === analysisId) || null;
  if (sourcePath) return docs.find((doc) => doc.sourcePath === sourcePath) || null;
  return null;
}

async function listRequirementEntries(apiBase, parent) {
  const data = await apiRequest(apiBase, `/${DOC_API.slice(1)}/list`, {
    method: 'POST',
    body: { path: parent || '.' },
  });
  return Array.isArray(data.entries) ? data.entries : [];
}

function uniqueUploadName(entries, originalName, ext) {
  const taken = new Set(
    (Array.isArray(entries) ? entries : [])
      .map((entry) => String(entry?.name || ''))
      .filter(Boolean),
  );
  if (!taken.has(originalName)) return originalName;
  const stem = path.basename(originalName, ext);
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  let name = `${stem}-${stamp}${ext}`;
  for (let suffix = 2; taken.has(name); suffix += 1) {
    name = `${stem}-${stamp}-${suffix}${ext}`;
  }
  return name;
}

async function readRequirementSource(apiBase, sourcePath) {
  const route = `/${REQ_API.slice(1)}/source?path=${encodeURIComponent(sourcePath)}`;
  return await apiRequest(apiBase, route, { timeoutMs: 60_000 });
}

async function withAnalysisSkillContext(apiBase, skillFile) {
  let entry = await findSpaceSkillByLegacy(apiBase, skillFile, { includeDisabled: true });
  if (!entry && SKILL_PROMPT_ROUTES[skillFile]) {
    // 新空间尚未打开过插件页时，先按插件边界补种子提示词，再迁移为空间技能。
    await apiRequest(apiBase, SKILL_PROMPT_ROUTES[skillFile]);
    await apiRequest(apiBase, SKILL_API, {
      method: 'POST',
      body: { action: 'migrate' },
    });
    entry = await findSpaceSkillByLegacy(apiBase, skillFile, { includeDisabled: true });
  }
  if (!entry) {
    throw new BridgeError(`未找到技能：${skillFile}`, 404);
  }
  if (entry.active === false) {
    throw new BridgeError(`技能已停用：${skillFile}`, 409, {
      skillId: entry.id,
      legacyPath: skillFile,
    });
  }
  return await readSpaceSkill(apiBase, entry.id);
}

async function prepareRequirementWorkflow(apiBase) {
  const current = await apiRequest(apiBase, CONFIG_API);
  const config = current.config || {};
  const plugins = config.plugins || {};
  const missing = REQUIREMENT_WORKFLOW_PLUGINS.filter((id) => plugins[id] !== true);
  if (missing.length) {
    await apiRequest(apiBase, CONFIG_API, {
      method: 'PUT',
      body: {
        configTarget: current.configTarget,
        config: {
          ...config,
          plugins: Object.fromEntries([
            ...Object.entries(plugins),
            ...REQUIREMENT_WORKFLOW_PLUGINS.map((id) => [id, true]),
          ]),
        },
      },
    });
  }
  await Promise.all(
    [
      `/${API_PREFIX.slice(1)}reqanalysis/prompt`,
      `/${API_PREFIX.slice(1)}storyreview/prompt`,
      `/${API_PREFIX.slice(1)}testpoints/prompt`,
    ].map((route) => apiRequest(apiBase, route)),
  );
  await apiRequest(apiBase, SKILL_API, {
    method: 'POST',
    body: { action: 'migrate' },
  });
  const skills = await listSpaceSkills(apiBase);
  const enabled = Object.fromEntries(REQUIREMENT_WORKFLOW_PLUGINS.map((id) => [id, true]));
  return {
    enabled,
    changed: missing.length > 0,
    missing,
    skillCount: skills.filter((skill) => skill.active !== false).length,
    skills: skills
      .filter((skill) => skill.active !== false)
      .map((skill) => ({
        id: skill.id,
        name: skill.name,
        variant: skill.variant,
        version: skill.version,
        legacyPath: skill.legacyPath,
      })),
  };
}

function artifactUrl(apiBase, doc) {
  return `${cleanBase(apiBase)}/requirement-analysis/?id=${encodeURIComponent(doc.id)}`;
}

function requireExpectedRevision(analysis, expectedRevision) {
  const currentRevision = analysisRevision(analysis);
  if (!expectedRevision) {
    throw new BridgeError('修改已有需求分析必须提供 expectedRevision；请先重新读取最新内容', 428, {
      analysisId: analysis.id,
      currentRevision,
      currentUpdatedAt: analysis.updatedAt || '',
    });
  }
  if (expectedRevision !== currentRevision) {
    throw new BridgeError('需求分析已被更新，请重新读取后再修改', 409, {
      analysisId: analysis.id,
      currentRevision,
      currentUpdatedAt: analysis.updatedAt || '',
    });
  }
  return currentRevision;
}

/**
 * @param {{ apiBase: string, version?: string }} opts
 */
export function createLanternMcpServer({ apiBase, version = '1.0.0' }) {
  const server = new McpServer(
    { name: 'lantern-harness', version, title: 'Lantern Harness Capabilities' },
    {
      instructions:
        'Lantern 提供测试业务规则、需求文档、需求分析、需求拆解库、测试点、功能用例生成、UI 自动化项目与脚本生成、自动化批量运行、缺陷规则与提交、业务地图和确定性校验。需求分析可列举和批量删除；需求拆解库通过 lantern_requirement_breakdown_* 管理本地 XMind 文件；功能用例通过 lantern_case_generation_* 校验和保存；UI 自动化项目通过 lantern_uiauto_* 管理，功能用例转换与正式运行通过 lantern_case_automation_* 管理；用例执行通过 lantern_case_execution_* 对单条用例启动 AI 浏览器执行、等待、停止、确认写回和同步统计；业务地图系统、目录、功能、流程、登录状态和本地资料可通过对应 lantern_business_* 工具管理，AI 目录/流程识别通过 lantern_business_assistant_* 启动和控制；缺陷规则、草稿、提交和回执通过 lantern_defect_* 管理。业务地图写入必须携带 expectedRevision。需要推理时先读取上下文，生成结构化结果后通过 Lantern 保存工具写回。通用测试统计通过 lantern_test_stats_* 查询、按日期/维度汇总、维护记录和维度；写入必须携带最新 expectedRevision，冲突后重新读取。外接 MCP（如腾讯文档）通过 lantern_mcp_tools 发现、lantern_mcp_call 调用，复用当前空间连接和权限。不要用浏览器点击 Lantern 页面。',
    },
  );

  server.registerTool(
    'lantern_status',
    {
      title: 'Lantern 状态',
      description: '检查 Lantern 本地能力服务、当前活动空间和可用空间列表。',
      annotations: { readOnlyHint: true },
    },
    protectedTool(async () => {
      const spaces = await apiRequest(apiBase, `/${API_PREFIX.slice(1)}spaces`);
      return toolResult({
        ok: true,
        apiBase,
        activeId: spaces.activeId || '',
        spaces: spaces.spaces || [],
      });
    }),
  );

  server.registerTool(
    'lantern_space_list',
    {
      title: '列出 Lantern 空间',
      description: '列出当前 Lantern 池根下的数据空间，并标记活动空间。',
      annotations: { readOnlyHint: true },
    },
    protectedTool(async () => {
      const data = await apiRequest(apiBase, `/${API_PREFIX.slice(1)}spaces`);
      return toolResult(data);
    }),
  );

  server.registerTool(
    'lantern_business_map_list',
    {
      title: '业务地图系统列表',
      description: '列出当前空间业务地图中的系统及目录、功能、流程数量，并返回当前 revision。',
      annotations: { readOnlyHint: true },
    },
    protectedTool(async () => toolResult(businessMapSummary(await loadBusinessMapStore(apiBase)))),
  );

  server.registerTool(
    'lantern_business_map_get',
    {
      title: '读取业务地图',
      description:
        '读取指定业务系统的目录、功能和流程。可按目录、功能、流程或关键词缩小范围；证据默认省略。',
      inputSchema: {
        systemId: z.string().describe('业务系统 ID'),
        directoryId: z.string().optional().describe('只返回该目录及其子目录'),
        functionId: z.string().optional().describe('只返回该功能及相关流程'),
        flowId: z.string().optional().describe('只返回该流程及相关功能'),
        query: z.string().optional().describe('按名称、编号、作用、角色等过滤'),
        includeEvidence: z.boolean().optional().describe('是否返回证据数组，默认 false'),
      },
      annotations: { readOnlyHint: true },
    },
    protectedTool(async (args) => {
      const store = await loadBusinessMapStore(apiBase);
      const system = requireBusinessSystem(store, args.systemId);
      return toolResult({
        ok: true,
        revision: store.revision,
        ...projectBusinessSystem(system, args),
      });
    }),
  );

  server.registerTool(
    'lantern_business_login_status',
    {
      title: '读取业务系统登录状态',
      description:
        '读取业务系统已保存的登录方式、账号是否存在、是否已有可用登录态；不会返回密码、Cookie 或 Token。',
      inputSchema: { systemId: z.string() },
      annotations: { readOnlyHint: true },
    },
    protectedTool(async ({ systemId }) =>
      toolResult(
        await apiRequest(
          apiBase,
          `${BUSINESS_MAP_API}/systems/${encodeURIComponent(systemId)}/login`,
        ),
      ),
    ),
  );

  server.registerTool(
    'lantern_business_login_start',
    {
      title: '启动业务系统登录验证',
      description:
        '使用 Lantern 已保存的登录配置启动验证；manual=true 时打开登录页面等待用户完成验证码或扫码。不接收密码。',
      inputSchema: {
        systemId: z.string(),
        manual: z.boolean().optional().describe('是否强制进入手动登录页面'),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    protectedTool(async ({ systemId, manual = false }) =>
      toolResult(
        await apiRequest(
          apiBase,
          `${BUSINESS_MAP_API}/systems/${encodeURIComponent(systemId)}/login/start`,
          { method: 'POST', body: { manual }, timeoutMs: 90_000 },
        ),
      ),
    ),
  );

  server.registerTool(
    'lantern_business_login_complete',
    {
      title: '保存已完成的业务登录态',
      description: '用户已在 Lantern 打开的登录页面完成验证码、扫码或 SSO 后，保存浏览器登录态。',
      inputSchema: { systemId: z.string() },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    protectedTool(async ({ systemId }) =>
      toolResult(
        await apiRequest(
          apiBase,
          `${BUSINESS_MAP_API}/systems/${encodeURIComponent(systemId)}/login/complete`,
          { method: 'POST', body: {}, timeoutMs: 60_000 },
        ),
      ),
    ),
  );

  server.registerTool(
    'lantern_business_login_cancel',
    {
      title: '取消业务系统登录验证',
      description: '关闭当前业务系统的登录窗口，不修改已经保存的登录配置。',
      inputSchema: { systemId: z.string() },
      annotations: { destructiveHint: true },
    },
    protectedTool(async ({ systemId }) =>
      toolResult(
        await apiRequest(
          apiBase,
          `${BUSINESS_MAP_API}/systems/${encodeURIComponent(systemId)}/login/cancel`,
          { method: 'POST', body: {} },
        ),
      ),
    ),
  );

  server.registerTool(
    'lantern_business_material_list',
    {
      title: '列出业务地图本地资料',
      description: '列出指定业务系统已上传的本地业务资料，返回文件名、大小和更新时间。',
      inputSchema: { systemId: z.string() },
      annotations: { readOnlyHint: true },
    },
    protectedTool(async ({ systemId }) =>
      toolResult(
        await apiRequest(
          apiBase,
          `${BUSINESS_MAP_API}/systems/${encodeURIComponent(systemId)}/materials`,
        ),
      ),
    ),
  );

  server.registerTool(
    'lantern_business_material_upload',
    {
      title: '上传业务地图本地资料',
      description:
        '把 Codex 可访问的 Word、Excel、Markdown、XMind、PPTX 等本地资料上传到指定业务系统，供后续 AI 识别使用。',
      inputSchema: {
        systemId: z.string(),
        filePath: z.string().describe('本地文件绝对路径'),
      },
      annotations: { destructiveHint: true },
    },
    protectedTool(async ({ systemId, filePath }) => {
      const absolute = path.resolve(String(filePath || ''));
      const stat = fs.statSync(absolute);
      if (!stat.isFile()) throw new BridgeError('filePath 不是文件');
      if (stat.size > MAX_BUSINESS_MATERIAL_BYTES) {
        throw new BridgeError(`业务资料超过 ${MAX_BUSINESS_MATERIAL_BYTES / 1024 / 1024} MB`);
      }
      const content = fs.readFileSync(absolute);
      return toolResult(
        await apiRequest(
          apiBase,
          `${BUSINESS_MAP_API}/systems/${encodeURIComponent(systemId)}/materials?name=${encodeURIComponent(path.basename(absolute))}`,
          {
            method: 'POST',
            rawBody: content,
            contentType: 'application/octet-stream',
            timeoutMs: 90_000,
          },
        ),
      );
    }),
  );

  server.registerTool(
    'lantern_business_material_delete',
    {
      title: '删除业务地图本地资料',
      description: '按文件名删除指定业务系统已上传的本地资料。',
      inputSchema: {
        systemId: z.string(),
        name: z.string().min(1),
      },
      annotations: { destructiveHint: true },
    },
    protectedTool(async ({ systemId, name }) =>
      toolResult(
        await apiRequest(
          apiBase,
          `${BUSINESS_MAP_API}/systems/${encodeURIComponent(systemId)}/materials?name=${encodeURIComponent(name)}`,
          { method: 'DELETE' },
        ),
      ),
    ),
  );

  server.registerTool(
    'lantern_business_system_save',
    {
      title: '新建或修改业务系统',
      description:
        '创建业务系统或修改系统名称、说明、入口、源码目录和文档范围。修改时必须携带 expectedRevision。',
      inputSchema: {
        expectedRevision: z.number().int().nonnegative().optional(),
        systemId: z.string().optional().describe('为空时新建'),
        name: z.string().optional(),
        description: z.string().optional(),
        entryUrl: z.string().optional(),
        sourceDir: z.string().optional(),
        analysisScope: z.string().optional(),
        docs: z
          .object({
            requirements: z.boolean().optional(),
            knowledge: z.boolean().optional(),
            scope: z.string().optional(),
          })
          .optional(),
      },
      annotations: { destructiveHint: true },
    },
    protectedTool(async (args) => {
      const revision = await requireBusinessMapRevision(apiBase, args.expectedRevision);
      const system = {
        ...(args.name !== undefined ? { name: args.name } : {}),
        ...(args.description !== undefined ? { description: args.description } : {}),
        ...(args.entryUrl !== undefined ? { entryUrl: args.entryUrl } : {}),
        ...(args.sourceDir !== undefined ? { sourceDir: args.sourceDir } : {}),
        ...(args.analysisScope !== undefined ? { analysisScope: args.analysisScope } : {}),
        ...(args.docs !== undefined ? { docs: args.docs } : {}),
      };
      let data;
      if (args.systemId) {
        data = await apiRequest(
          apiBase,
          `${BUSINESS_MAP_API}/systems/${encodeURIComponent(args.systemId)}`,
          { method: 'PUT', body: { revision, system } },
        );
      } else {
        if (!String(args.name || '').trim()) throw new BridgeError('新建系统必须提供 name');
        data = await apiRequest(apiBase, `${BUSINESS_MAP_API}/systems`, {
          method: 'POST',
          body: { revision, system },
        });
      }
      const saved = requireBusinessSystem(data.store, args.systemId || data.systemId);
      return toolResult({
        ok: true,
        revision: data.store.revision,
        systemId: saved.id,
        system: projectBusinessSystem(saved, {}).system,
      });
    }),
  );

  server.registerTool(
    'lantern_business_system_delete',
    {
      title: '删除业务系统',
      description: '删除业务系统及其全部目录、功能、流程、AI 会话和本机资料。',
      inputSchema: {
        systemId: z.string(),
        expectedRevision: z.number().int().nonnegative().optional(),
      },
      annotations: { destructiveHint: true },
    },
    protectedTool(async ({ systemId, expectedRevision }) => {
      const revision = await requireBusinessMapRevision(apiBase, expectedRevision);
      const data = await apiRequest(
        apiBase,
        `${BUSINESS_MAP_API}/systems/${encodeURIComponent(systemId)}`,
        { method: 'DELETE', body: { revision } },
      );
      return toolResult({ ok: true, revision: data.store.revision, deletedSystemId: systemId });
    }),
  );

  server.registerTool(
    'lantern_business_directory_save',
    {
      title: '新建或修改功能目录',
      description:
        '新建目录或修改目录名称、父目录、排序、菜单路径和入口。写入必须携带 expectedRevision。',
      inputSchema: {
        expectedRevision: z.number().int().nonnegative().optional(),
        systemId: z.string(),
        directoryId: z.string().optional().describe('为空时新建目录'),
        name: z.string().optional(),
        parentId: z.string().optional().describe('根目录为空字符串'),
        order: z.number().int().nonnegative().optional(),
        source: z.enum(['menu', 'ai', 'manual']).optional(),
        menuPath: z.array(z.string()).optional(),
        entryUrl: z.string().optional(),
        evidence: businessEvidenceInput,
      },
      annotations: { destructiveHint: true },
    },
    protectedTool(async (args) => {
      const revision = await requireBusinessMapRevision(apiBase, args.expectedRevision);
      const directory = {
        ...(args.name !== undefined ? { name: args.name } : {}),
        ...(args.parentId !== undefined ? { parentId: args.parentId } : {}),
        ...(args.order !== undefined ? { order: args.order } : {}),
        ...(args.source !== undefined ? { source: args.source } : {}),
        ...(args.menuPath !== undefined ? { menuPath: args.menuPath } : {}),
        ...(args.entryUrl !== undefined ? { entryUrl: args.entryUrl } : {}),
        ...(args.evidence !== undefined ? { evidence: args.evidence } : {}),
      };
      let data;
      if (args.directoryId) {
        data = await apiRequest(
          apiBase,
          `${BUSINESS_MAP_API}/systems/${encodeURIComponent(args.systemId)}/directories/${encodeURIComponent(args.directoryId)}`,
          { method: 'PUT', body: { revision, directory } },
        );
      } else {
        if (!String(args.name || '').trim()) throw new BridgeError('新建目录必须提供 name');
        data = await apiRequest(
          apiBase,
          `${BUSINESS_MAP_API}/systems/${encodeURIComponent(args.systemId)}/directories`,
          { method: 'POST', body: { revision, directory } },
        );
      }
      return toolResult({
        ok: true,
        revision: data.store.revision,
        directory: data.directory,
      });
    }),
  );

  server.registerTool(
    'lantern_business_tree_move',
    {
      title: '移动或排序业务目录节点',
      description:
        '移动目录或功能到目标父级，并可通过 beforeId 指定插入位置。写入必须携带 expectedRevision。',
      inputSchema: {
        expectedRevision: z.number().int().nonnegative().optional(),
        systemId: z.string(),
        kind: z.enum(['directory', 'function']),
        id: z.string(),
        parentId: z.string().describe('目标父目录；根级为空字符串'),
        beforeId: z.string().optional().describe('插入到该同级节点之前；省略则追加'),
      },
      annotations: { destructiveHint: true },
    },
    protectedTool(async ({ expectedRevision, systemId, kind, id, parentId, beforeId }) => {
      const revision = await requireBusinessMapRevision(apiBase, expectedRevision);
      const data = await apiRequest(
        apiBase,
        `${BUSINESS_MAP_API}/systems/${encodeURIComponent(systemId)}/tree/move`,
        {
          method: 'POST',
          body: { revision, kind, id, parentId, ...(beforeId ? { beforeId } : {}) },
        },
      );
      return toolResult({ ok: true, revision: data.store.revision });
    }),
  );

  server.registerTool(
    'lantern_business_directory_delete',
    {
      title: '删除功能目录',
      description:
        '删除目录。非空目录首次调用会返回 impact；确认级联删除后传 cascade=true。写入必须携带 expectedRevision。',
      inputSchema: {
        expectedRevision: z.number().int().nonnegative().optional(),
        systemId: z.string(),
        directoryId: z.string(),
        cascade: z.boolean().optional(),
      },
      annotations: { destructiveHint: true },
    },
    protectedTool(async ({ expectedRevision, systemId, directoryId, cascade = false }) => {
      const revision = await requireBusinessMapRevision(apiBase, expectedRevision);
      const data = await apiRequest(
        apiBase,
        `${BUSINESS_MAP_API}/systems/${encodeURIComponent(systemId)}/directories/${encodeURIComponent(directoryId)}`,
        { method: 'DELETE', body: { revision, cascade } },
      );
      return toolResult({
        ok: true,
        revision: data.store.revision,
        deletedDirectoryId: directoryId,
        ...(data.impact ? { impact: data.impact } : {}),
      });
    }),
  );

  server.registerTool(
    'lantern_business_function_save',
    {
      title: '新建或修改业务功能',
      description:
        '新建功能或修改所属目录、名称、作用、角色、规则、证据等字段。写入必须携带 expectedRevision。',
      inputSchema: {
        expectedRevision: z.number().int().nonnegative().optional(),
        systemId: z.string(),
        functionId: z.string().optional().describe('为空时新建功能'),
        name: z.string().optional(),
        code: z.string().optional(),
        directoryId: z.string().optional(),
        order: z.number().int().nonnegative().optional(),
        domain: z.string().optional(),
        module: z.string().optional(),
        status: z.enum(['在用', '停用', '草稿']).optional(),
        purpose: z.string().optional(),
        roles: z.array(z.string()).optional(),
        entry: z.string().optional(),
        inputs: z.array(z.string()).optional(),
        outputs: z.array(z.string()).optional(),
        rules: z.array(z.string()).optional(),
        writes: z.array(z.string()).optional(),
        exceptions: z.array(z.string()).optional(),
        implementation: z.array(z.string()).optional(),
        evidence: businessEvidenceInput,
        confidence: z.enum(['high', 'medium', 'low']).optional(),
        source: z.enum(['ai', 'manual', 'mixed']).optional(),
        confirmed: z.boolean().optional(),
        lockedFields: z.array(z.string()).optional(),
      },
      annotations: { destructiveHint: true },
    },
    protectedTool(async (args) => {
      const revision = await requireBusinessMapRevision(apiBase, args.expectedRevision);
      const fn = {
        ...(args.name !== undefined ? { name: args.name } : {}),
        ...(args.code !== undefined ? { code: args.code } : {}),
        ...(args.directoryId !== undefined ? { directoryId: args.directoryId } : {}),
        ...(args.order !== undefined ? { order: args.order } : {}),
        ...(args.domain !== undefined ? { domain: args.domain } : {}),
        ...(args.module !== undefined ? { module: args.module } : {}),
        ...(args.status !== undefined ? { status: args.status } : {}),
        ...(args.purpose !== undefined ? { purpose: args.purpose } : {}),
        ...(args.roles !== undefined ? { roles: args.roles } : {}),
        ...(args.entry !== undefined ? { entry: args.entry } : {}),
        ...(args.inputs !== undefined ? { inputs: args.inputs } : {}),
        ...(args.outputs !== undefined ? { outputs: args.outputs } : {}),
        ...(args.rules !== undefined ? { rules: args.rules } : {}),
        ...(args.writes !== undefined ? { writes: args.writes } : {}),
        ...(args.exceptions !== undefined ? { exceptions: args.exceptions } : {}),
        ...(args.implementation !== undefined ? { implementation: args.implementation } : {}),
        ...(args.evidence !== undefined ? { evidence: args.evidence } : {}),
        ...(args.confidence !== undefined ? { confidence: args.confidence } : {}),
        ...(args.source !== undefined ? { source: args.source } : {}),
        ...(args.confirmed !== undefined ? { confirmed: args.confirmed } : {}),
        ...(args.lockedFields !== undefined ? { lockedFields: args.lockedFields } : {}),
      };
      let data;
      if (args.functionId) {
        data = await apiRequest(
          apiBase,
          `${BUSINESS_MAP_API}/systems/${encodeURIComponent(args.systemId)}/functions/${encodeURIComponent(args.functionId)}`,
          { method: 'PUT', body: { revision, function: fn } },
        );
      } else {
        if (!String(args.name || '').trim()) throw new BridgeError('新建功能必须提供 name');
        data = await apiRequest(
          apiBase,
          `${BUSINESS_MAP_API}/systems/${encodeURIComponent(args.systemId)}/functions`,
          { method: 'POST', body: { revision, function: fn } },
        );
      }
      return toolResult({ ok: true, revision: data.store.revision, item: data.item });
    }),
  );

  server.registerTool(
    'lantern_business_function_delete',
    {
      title: '删除业务功能',
      description: '删除功能，并清空业务流程中对该功能的引用。写入必须携带 expectedRevision。',
      inputSchema: {
        expectedRevision: z.number().int().nonnegative().optional(),
        systemId: z.string(),
        functionId: z.string(),
      },
      annotations: { destructiveHint: true },
    },
    protectedTool(async ({ expectedRevision, systemId, functionId }) => {
      const revision = await requireBusinessMapRevision(apiBase, expectedRevision);
      const data = await apiRequest(
        apiBase,
        `${BUSINESS_MAP_API}/systems/${encodeURIComponent(systemId)}/functions/${encodeURIComponent(functionId)}`,
        { method: 'DELETE', body: { revision } },
      );
      return toolResult({ ok: true, revision: data.store.revision, deletedFunctionId: functionId });
    }),
  );

  server.registerTool(
    'lantern_business_flow_save',
    {
      title: '新建或修改业务流程',
      description:
        '新建或修改业务流程及纵向步骤。系统步骤必须引用已存在功能；写入必须携带 expectedRevision。',
      inputSchema: {
        expectedRevision: z.number().int().nonnegative().optional(),
        systemId: z.string(),
        flowId: z.string().optional().describe('为空时新建流程'),
        name: z.string().optional(),
        result: z.string().optional(),
        status: z.enum(['健康', '待补全', '草稿']).optional(),
        steps: z
          .array(
            z.object({
              id: z.string().optional(),
              n: z.number().int().min(1).optional(),
              title: z.string(),
              role: z.string().optional(),
              system: z.string().optional(),
              functionId: z.string().optional(),
              input: z.string().optional(),
              output: z.string().optional(),
              next: z.string().optional(),
              branch: z.string().optional(),
              branchBroken: z.boolean().optional(),
              manual: z.boolean().optional(),
              dependencies: businessDependencyInput,
              evidence: businessEvidenceInput,
            }),
          )
          .optional(),
        evidence: businessEvidenceInput,
      },
      annotations: { destructiveHint: true },
    },
    protectedTool(async (args) => {
      const revision = await requireBusinessMapRevision(apiBase, args.expectedRevision);
      const flow = {
        ...(args.name !== undefined ? { name: args.name } : {}),
        ...(args.result !== undefined ? { result: args.result } : {}),
        ...(args.status !== undefined ? { status: args.status } : {}),
        ...(args.steps !== undefined ? { steps: args.steps } : {}),
        ...(args.evidence !== undefined ? { evidence: args.evidence } : {}),
      };
      let data;
      if (args.flowId) {
        data = await apiRequest(
          apiBase,
          `${BUSINESS_MAP_API}/systems/${encodeURIComponent(args.systemId)}/flows/${encodeURIComponent(args.flowId)}`,
          { method: 'PUT', body: { revision, flow } },
        );
      } else {
        if (!String(args.name || '').trim()) throw new BridgeError('新建流程必须提供 name');
        data = await apiRequest(
          apiBase,
          `${BUSINESS_MAP_API}/systems/${encodeURIComponent(args.systemId)}/flows`,
          { method: 'POST', body: { revision, flow } },
        );
      }
      return toolResult({ ok: true, revision: data.store.revision, item: data.item });
    }),
  );

  server.registerTool(
    'lantern_business_flow_delete',
    {
      title: '删除业务流程',
      description: '删除业务流程。写入必须携带 expectedRevision。',
      inputSchema: {
        expectedRevision: z.number().int().nonnegative().optional(),
        systemId: z.string(),
        flowId: z.string(),
      },
      annotations: { destructiveHint: true },
    },
    protectedTool(async ({ expectedRevision, systemId, flowId }) => {
      const revision = await requireBusinessMapRevision(apiBase, expectedRevision);
      const data = await apiRequest(
        apiBase,
        `${BUSINESS_MAP_API}/systems/${encodeURIComponent(systemId)}/flows/${encodeURIComponent(flowId)}`,
        { method: 'DELETE', body: { revision } },
      );
      return toolResult({ ok: true, revision: data.store.revision, deletedFlowId: flowId });
    }),
  );

  server.registerTool(
    'lantern_business_assistant_get',
    {
      title: '读取业务地图 AI 会话',
      description:
        '读取指定系统的持久化 AI 会话、当前草案、消息和增量日志。afterSeq 用于只返回新事件。',
      inputSchema: {
        systemId: z.string(),
        afterSeq: z.number().int().nonnegative().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    protectedTool(async ({ systemId, afterSeq = 0 }) => {
      const data = await apiRequest(
        apiBase,
        `${BUSINESS_MAP_API}/systems/${encodeURIComponent(systemId)}/assistant`,
      );
      const session = data.session;
      return toolResult({
        ok: true,
        session: {
          ...session,
          events: (session?.events || []).filter(
            (event) => Number(event.seq) > Math.max(0, Number(afterSeq) || 0),
          ),
        },
      });
    }),
  );

  server.registerTool(
    'lantern_business_assistant_send',
    {
      title: '启动业务地图 AI 识别',
      description:
        '启动功能目录或业务流程识别回合，后台继续执行。使用 Lantern 当前模型配置，不接收模型密钥。',
      inputSchema: {
        expectedRevision: z.number().int().nonnegative().optional(),
        systemId: z.string(),
        phase: z.enum(['directory', 'flow']),
        message: z.string().min(1),
        refresh: z.boolean().optional().describe('是否强制重新扫描菜单和页面'),
        maxPages: z.number().int().min(1).max(300).optional(),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    protectedTool(async ({ expectedRevision, systemId, phase, message, refresh, maxPages }) => {
      const revision = await requireBusinessMapRevision(apiBase, expectedRevision);
      const settings = await loadBusinessModelSettings(apiBase);
      const data = await apiRequest(
        apiBase,
        `${BUSINESS_MAP_API}/systems/${encodeURIComponent(systemId)}/assistant/messages`,
        {
          method: 'POST',
          body: {
            revision,
            phase,
            message,
            ...(refresh !== undefined ? { refresh } : {}),
            ...(maxPages !== undefined ? { maxPages } : {}),
            settings,
          },
          timeoutMs: 60_000,
        },
      );
      return toolResult({ ok: true, session: data.session });
    }),
  );

  server.registerTool(
    'lantern_business_assistant_stop',
    {
      title: '停止业务地图 AI 识别',
      description: '停止当前系统的 AI 回合，保留会话历史和草案。',
      inputSchema: { systemId: z.string() },
      annotations: { destructiveHint: true },
    },
    protectedTool(async ({ systemId }) => {
      const data = await apiRequest(
        apiBase,
        `${BUSINESS_MAP_API}/systems/${encodeURIComponent(systemId)}/assistant/stop`,
        { method: 'POST', body: {} },
      );
      return toolResult({ ok: true, session: data.session });
    }),
  );

  server.registerTool(
    'lantern_business_assistant_reset',
    {
      title: '重置业务地图 AI 会话',
      description: '清空指定系统的消息、日志和草案，不修改已经应用的正式业务地图。',
      inputSchema: { systemId: z.string() },
      annotations: { destructiveHint: true },
    },
    protectedTool(async ({ systemId }) => {
      const data = await apiRequest(
        apiBase,
        `${BUSINESS_MAP_API}/systems/${encodeURIComponent(systemId)}/assistant/reset`,
        { method: 'POST', body: {} },
      );
      return toolResult({ ok: true, session: data.session });
    }),
  );

  server.registerTool(
    'lantern_business_assistant_apply',
    {
      title: '应用业务地图 AI 草案',
      description: '把当前等待确认的目录或流程草案写入正式地图。必须携带 expectedRevision。',
      inputSchema: {
        systemId: z.string(),
        expectedRevision: z.number().int().nonnegative().optional(),
      },
      annotations: { destructiveHint: true },
    },
    protectedTool(async ({ systemId, expectedRevision }) => {
      const revision = await requireBusinessMapRevision(apiBase, expectedRevision);
      const data = await apiRequest(
        apiBase,
        `${BUSINESS_MAP_API}/systems/${encodeURIComponent(systemId)}/assistant/apply`,
        { method: 'POST', body: { revision } },
      );
      return toolResult({
        ok: true,
        session: data.session,
        revision: data.store?.revision ?? revision + 1,
      });
    }),
  );

  server.registerTool(
    'lantern_business_assistant_wait',
    {
      title: '等待业务地图 AI 回合',
      description: '轮询当前 AI 会话，直到结束或超时；返回最新状态和 afterSeq 之后的日志。',
      inputSchema: {
        systemId: z.string(),
        timeoutMs: z.number().int().min(1000).max(55_000).optional(),
        afterSeq: z.number().int().nonnegative().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    protectedTool(async ({ systemId, timeoutMs = 25_000, afterSeq = 0 }) =>
      toolResult(await waitForBusinessAssistant(apiBase, systemId, timeoutMs, afterSeq)),
    ),
  );

  const caseDesignInput = {
    analysisId: z.string().optional(),
    sourcePath: z.string().optional(),
    headers: z.array(z.string()).optional(),
    skillPath: z.string().optional(),
  };
  const caseDesignRows = { ...caseDesignInput, rows: z.array(z.record(z.string(), z.unknown())) };
  server.registerTool(
    'lantern_case_generation_context',
    {
      title: '读取用例生成上下文',
      description:
        '读取需求基线、当前空间用例生成技能、执行就绪表头与输出约定。由 Codex 生成 rows 后校验和保存。',
      inputSchema: caseDesignInput,
      annotations: { readOnlyHint: true },
    },
    protectedTool(async (args) =>
      toolResult(
        await apiRequest(apiBase, '/__tb_case_design/context', { method: 'POST', body: args }),
      ),
    ),
  );
  server.registerTool(
    'lantern_case_generation_validate',
    {
      title: '校验生成用例与需求覆盖',
      description: '确定性检查字段、真实 RO/US/TP 引用与覆盖；不保存，不使用模型自报覆盖率。',
      inputSchema: caseDesignRows,
      annotations: { readOnlyHint: true },
    },
    protectedTool(async (args) =>
      toolResult(
        await apiRequest(apiBase, '/__tb_case_design/validate', { method: 'POST', body: args }),
      ),
    ),
  );
  server.registerTool(
    'lantern_case_generation_save',
    {
      title: '保存生成用例',
      description:
        '在用例管理新建实际文件，补齐执行列并登记需求基线和稳定标识；必须传 context 返回的 revision 与 sourceFileHash。',
      inputSchema: {
        ...caseDesignRows,
        expectedRevision: z.string().optional(),
        expectedSourceFileHash: z.string().optional(),
        title: z.string(),
        format: z.enum(['xlsx', 'csv', 'md']).optional(),
        folder: z
          .string()
          .optional()
          .describe('用例管理内的相对分类目录，例如 功能测试；留空保存在根目录'),
      },
      annotations: { destructiveHint: true },
    },
    protectedTool(async (args) =>
      toolResult(
        await apiRequest(apiBase, '/__tb_case_design/save', { method: 'POST', body: args }),
      ),
    ),
  );

  server.registerTool(
    'lantern_uiauto_projects',
    {
      title: '列出 UI 自动化项目',
      description:
        '列出当前空间已挂载或生成的 UI 自动化项目，附带框架、目录、运行环境与可挂载状态。',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    protectedTool(async () => toolResult(await apiRequest(apiBase, `${UI_AUTO_API}/projects`))),
  );

  server.registerTool(
    'lantern_uiauto_project_mount',
    {
      title: '挂载已有 UI 自动化项目',
      description:
        '把 Codex 可访问的现有测试项目目录挂载到 Lantern；目录必须存在且能识别出 Playwright、pytest 或 Selenium。',
      inputSchema: {
        dir: z.string().describe('测试项目的绝对目录'),
        name: z.string().optional(),
        framework: z.enum(['playwright', 'pytest', 'selenium']).optional(),
      },
      annotations: { destructiveHint: true },
    },
    protectedTool(async (args) =>
      toolResult(
        await apiRequest(apiBase, `${UI_AUTO_API}/projects`, { method: 'POST', body: args }),
      ),
    ),
  );

  server.registerTool(
    'lantern_uiauto_project_update',
    {
      title: '更新 UI 自动化项目配置',
      description:
        '修改项目展示名、探测目录、框架、被测地址、storageState 文件、登录策略和默认环境；不接收账号密码。',
      inputSchema: {
        projectId: z.string(),
        name: z.string().optional(),
        framework: z.enum(['playwright', 'pytest', 'selenium']).optional(),
        dir: z.string().optional(),
        baseURL: z.string().optional(),
        storageState: z.string().optional().describe('项目内或本机可访问的登录态文件路径'),
        loginStrategy: z.enum(['ask_each_time', 'ui_orchestrate', 'sso']).optional(),
        envName: z.string().optional(),
        promptFile: z.string().optional(),
      },
      annotations: { destructiveHint: true },
    },
    protectedTool(async ({ projectId, ...values }) =>
      toolResult(
        await apiRequest(apiBase, `${UI_AUTO_API}/projects`, {
          method: 'PATCH',
          body: { id: projectId, ...values },
        }),
      ),
    ),
  );

  const scaffoldInput = {
    parentDir: z.string().describe('新建项目所在父目录的绝对路径'),
    name: z.string().min(1),
    stack: z.string().optional().describe('默认 playwright'),
    baseURL: z.string().optional(),
    options: z.array(z.string()).optional(),
  };
  server.registerTool(
    'lantern_uiauto_project_scaffold_preview',
    {
      title: '预览 UI 自动化项目骨架',
      description:
        '对指定父目录和项目名执行结构检查与文件预览，不创建目录；用于用户确认将要生成的项目。',
      inputSchema: scaffoldInput,
      annotations: { readOnlyHint: true },
    },
    protectedTool(async (args) => {
      const check = await apiRequest(apiBase, `${UI_AUTO_API}/scaffold/check`, {
        method: 'POST',
        body: args,
      });
      const preview = await apiRequest(apiBase, `${UI_AUTO_API}/scaffold/preview`, {
        method: 'POST',
        body: args,
      });
      return toolResult({ ok: check.ok && preview.ok, check, preview });
    }),
  );

  server.registerTool(
    'lantern_uiauto_project_scaffold_create',
    {
      title: '创建一个 UI 自动化项目',
      description:
        '按当前空间骨架在指定父目录创建并挂载 UI 自动化项目；不覆盖已有非空目录，不自动安装依赖。',
      inputSchema: scaffoldInput,
      annotations: { destructiveHint: true },
    },
    protectedTool(async (args) =>
      toolResult(
        await apiRequest(apiBase, `${UI_AUTO_API}/scaffold`, { method: 'POST', body: args }),
      ),
    ),
  );

  server.registerTool(
    'lantern_uiauto_project_setup_start',
    {
      title: '开始安装 UI 自动化项目环境',
      description: '启动项目依赖与浏览器运行时安装；同一项目不能重复启动。',
      inputSchema: { projectId: z.string() },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    protectedTool(async ({ projectId }) =>
      toolResult(
        await apiRequest(apiBase, `${UI_AUTO_API}/project/setup`, {
          method: 'POST',
          body: { projectId },
        }),
      ),
    ),
  );

  server.registerTool(
    'lantern_uiauto_project_setup_get',
    {
      title: '读取 UI 自动化项目安装进度',
      description: '读取项目安装日志和当前状态；offset 用于只取新增日志。',
      inputSchema: {
        projectId: z.string(),
        offset: z.number().int().nonnegative().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    protectedTool(async ({ projectId, offset = 0 }) =>
      toolResult(
        await apiRequest(
          apiBase,
          `${UI_AUTO_API}/project/setup?projectId=${encodeURIComponent(projectId)}&offset=${offset}`,
        ),
      ),
    ),
  );

  server.registerTool(
    'lantern_uiauto_project_setup_stop',
    {
      title: '停止 UI 自动化项目安装',
      description: '停止当前项目的安装任务并保留已有日志。',
      inputSchema: { projectId: z.string() },
      annotations: { destructiveHint: true },
    },
    protectedTool(async ({ projectId }) =>
      toolResult(
        await apiRequest(apiBase, `${UI_AUTO_API}/project/setup/stop`, {
          method: 'POST',
          body: { projectId },
        }),
      ),
    ),
  );

  server.registerTool(
    'lantern_case_automation_cases',
    {
      title: '读取待转换的功能用例',
      description: '读取功能用例文件中的稳定用例 ID、步骤、预期和当前执行状态。',
      inputSchema: { casePath: z.string() },
      annotations: { readOnlyHint: true },
    },
    protectedTool(async ({ casePath }) =>
      toolResult(
        await apiRequest(
          apiBase,
          `${CASE_AUTOMATION_API}/cases?path=${encodeURIComponent(casePath)}`,
        ),
      ),
    ),
  );

  server.registerTool(
    'lantern_case_automation_iterations',
    {
      title: '列出 UI 自动化迭代文件',
      description:
        '读取指定 UI 项目的 tests/iteration 文件，并按源用例文件名版本自动给出建议迭代。',
      inputSchema: { projectId: z.string(), casePath: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    protectedTool(async ({ projectId, casePath = '' }) =>
      toolResult(
        await apiRequest(
          apiBase,
          `${CASE_AUTOMATION_API}/iterations?projectId=${encodeURIComponent(projectId)}&casePath=${encodeURIComponent(casePath)}`,
        ),
      ),
    ),
  );

  server.registerTool(
    'lantern_case_automation_status',
    {
      title: '读取功能用例自动化状态',
      description: '按用例 ID 返回自动化链接、脚本、运行、报告和过期状态。',
      inputSchema: { casePath: z.string() },
      annotations: { readOnlyHint: true },
    },
    protectedTool(async ({ casePath }) =>
      toolResult(
        await apiRequest(
          apiBase,
          `${CASE_AUTOMATION_API}/status?casePath=${encodeURIComponent(casePath)}`,
        ),
      ),
    ),
  );

  server.registerTool(
    'lantern_case_automation_assess',
    {
      title: '评估并拆分功能用例为 UI 自动化用例',
      description:
        '调用 Lantern 当前模型评估明确选择的功能用例，生成自动化用例和 UI Plan；会保存评估记录，但不会修改正式地图或测试项目。',
      inputSchema: {
        casePath: z.string(),
        caseIds: z.array(z.string()).min(1).max(100),
        projectId: z.string(),
        iteration: z.string(),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    protectedTool(async (args) =>
      toolResult(
        await apiRequest(apiBase, `${CASE_AUTOMATION_API}/assess`, {
          method: 'POST',
          body: args,
          timeoutMs: 100_000,
        }),
      ),
    ),
  );

  server.registerTool(
    'lantern_case_automation_apply',
    {
      title: '应用自动化评估结果',
      description:
        '把用户确认过的评估结果写入自动化用例文件，并创建绑定 automationCaseId、迭代文件和目标脚本的 UI 生成会话。',
      inputSchema: {
        assessmentId: z.string(),
        selectedSourceCaseIds: z.array(z.string()).min(1),
      },
      annotations: { destructiveHint: true },
    },
    protectedTool(async (args) =>
      toolResult(
        await apiRequest(apiBase, `${CASE_AUTOMATION_API}/apply`, {
          method: 'POST',
          body: args,
        }),
      ),
    ),
  );

  server.registerTool(
    'lantern_case_automation_run',
    {
      title: '正式运行自动化用例',
      description:
        '按 automationCaseId 启动已写入 iteration 文件的自动化测试批次；串行运行，返回批次 ID 供轮询。',
      inputSchema: {
        automationCaseIds: z.array(z.string()).min(1),
        env: z.string().optional(),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    protectedTool(async (args) =>
      toolResult(
        await apiRequest(apiBase, `${CASE_AUTOMATION_API}/runs`, {
          method: 'POST',
          body: args,
        }),
      ),
    ),
  );

  server.registerTool(
    'lantern_case_automation_run_get',
    {
      title: '读取自动化运行批次',
      description: '读取批次状态、逐 automationCaseId 结果、报告地址和中断原因。',
      inputSchema: { batchId: z.string() },
      annotations: { readOnlyHint: true },
    },
    protectedTool(async ({ batchId }) =>
      toolResult(
        await apiRequest(apiBase, `${CASE_AUTOMATION_API}/runs/${encodeURIComponent(batchId)}`),
      ),
    ),
  );

  server.registerTool(
    'lantern_case_automation_run_wait',
    {
      title: '等待自动化运行批次结束',
      description: '轮询批次直到结束或达到本轮最长等待时间。',
      inputSchema: {
        batchId: z.string(),
        timeoutMs: z.number().int().min(1000).max(55_000).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    protectedTool(async ({ batchId, timeoutMs = 25_000 }) =>
      toolResult(await waitForCaseAutomationBatch(apiBase, batchId, timeoutMs)),
    ),
  );

  server.registerTool(
    'lantern_case_automation_run_stop',
    {
      title: '停止自动化运行批次',
      description: '停止当前批次和正在运行的项目进程，保留已有日志与报告。',
      inputSchema: { batchId: z.string() },
      annotations: { destructiveHint: true },
    },
    protectedTool(async ({ batchId }) =>
      toolResult(
        await apiRequest(
          apiBase,
          `${CASE_AUTOMATION_API}/runs/${encodeURIComponent(batchId)}/stop`,
          { method: 'POST', body: {} },
        ),
      ),
    ),
  );

  server.registerTool(
    'lantern_uiauto_agent_session_get',
    {
      title: '读取 UI 自动化生成会话',
      description:
        '读取 Plan、IR、探索状态、建议脚本路径、草稿与项目变更；automationCaseId 会话可直接从应用结果中的 uiSessionId 打开。',
      inputSchema: { sessionId: z.string() },
      annotations: { readOnlyHint: true },
    },
    protectedTool(async ({ sessionId }) =>
      toolResult(
        await apiRequest(
          apiBase,
          `${UI_AUTO_API}/agent/session?id=${encodeURIComponent(sessionId)}`,
        ),
      ),
    ),
  );

  server.registerTool(
    'lantern_uiauto_agent_open',
    {
      title: '打开 UI 自动化探索页面',
      description: '在会话绑定的项目中启动或复用只读受控浏览器并打开页面，返回当前可交互元素快照。',
      inputSchema: {
        sessionId: z.string(),
        url: z.string(),
        settle: z.number().int().min(0).max(10_000).optional(),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    protectedTool(async (args) =>
      toolResult(
        await apiRequest(apiBase, `${UI_AUTO_API}/agent/open`, {
          method: 'POST',
          body: args,
          timeoutMs: 60_000,
        }),
      ),
    ),
  );

  server.registerTool(
    'lantern_uiauto_agent_snapshot',
    {
      title: '读取 UI 自动化页面快照',
      description: '读取当前页面可交互元素引用、角色、文本和层级，供定位器绑定与步骤设计使用。',
      inputSchema: {
        sessionId: z.string(),
        depth: z.number().int().min(1).max(20).optional(),
        targetRef: z.string().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    protectedTool(async (args) =>
      toolResult(
        await apiRequest(apiBase, `${UI_AUTO_API}/agent/snapshot`, {
          method: 'POST',
          body: args,
          timeoutMs: 45_000,
        }),
      ),
    ),
  );

  server.registerTool(
    'lantern_uiauto_agent_action',
    {
      title: '操作 UI 自动化探索页面',
      description:
        '点击、填写、选择、悬停、按键、勾选、滚动、后退或刷新当前页面；可能修改目标系统数据，须符合用户授权。',
      inputSchema: {
        sessionId: z.string(),
        action: z.enum([
          'click',
          'fill',
          'select',
          'hover',
          'press',
          'check',
          'uncheck',
          'scroll',
          'back',
          'reload',
        ]),
        ref: z.string().optional(),
        text: z.string().optional(),
        value: z.string().optional(),
        key: z.string().optional(),
        note: z.string().optional(),
        snapshot: z.boolean().optional(),
        settle: z.number().int().min(0).max(10_000).optional(),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    protectedTool(async (args) =>
      toolResult(
        await apiRequest(apiBase, `${UI_AUTO_API}/agent/action`, {
          method: 'POST',
          body: args,
          timeoutMs: 100_000,
        }),
      ),
    ),
  );

  server.registerTool(
    'lantern_uiauto_agent_wait',
    {
      title: '等待 UI 自动化页面条件',
      description: '等待页面出现指定文本或固定时间；用于异步加载、提交结果和弹窗。',
      inputSchema: {
        sessionId: z.string(),
        text: z.string().optional(),
        ms: z.number().int().min(0).max(15_000).optional(),
        timeout: z.number().int().min(1000).max(60_000).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    protectedTool(async (args) =>
      toolResult(
        await apiRequest(apiBase, `${UI_AUTO_API}/agent/wait`, {
          method: 'POST',
          body: args,
          timeoutMs: 70_000,
        }),
      ),
    ),
  );

  server.registerTool(
    'lantern_uiauto_agent_probe',
    {
      title: '探测 UI 元素定位器',
      description: '把页面引用解析为可写入脚本的定位器；提供 stepId 时同时回填当前 Plan 步骤。',
      inputSchema: {
        sessionId: z.string(),
        ref: z.string(),
        stepId: z.string().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    protectedTool(async (args) =>
      toolResult(
        await apiRequest(apiBase, `${UI_AUTO_API}/agent/probe`, {
          method: 'POST',
          body: args,
          timeoutMs: 45_000,
        }),
      ),
    ),
  );

  server.registerTool(
    'lantern_uiauto_agent_save',
    {
      title: '保存 UI 自动化 Plan 与 IR',
      description:
        '保存生成会话的标题、计划、IR、说明和活动日志；mergePlan=true 时只合并不覆盖用户已有步骤。',
      inputSchema: {
        sessionId: z.string(),
        title: z.string().optional(),
        target: z.enum(['ts', 'python']).optional(),
        baseURL: z.string().optional(),
        source: z.string().optional(),
        plan: z.array(z.record(z.string(), z.unknown())).optional(),
        mergePlan: z.boolean().optional(),
        allowEmptyPlan: z.boolean().optional(),
        ir: z.record(z.string(), z.unknown()).nullable().optional(),
        activity: z.array(z.record(z.string(), z.unknown())).optional(),
        replaceActivity: z.boolean().optional(),
        narrative: z.string().optional(),
        status: z.string().optional(),
      },
      annotations: { destructiveHint: true },
    },
    protectedTool(async (args) =>
      toolResult(
        await apiRequest(apiBase, `${UI_AUTO_API}/agent/save`, {
          method: 'POST',
          body: args,
        }),
      ),
    ),
  );

  server.registerTool(
    'lantern_uiauto_agent_emit',
    {
      title: '生成 UI 自动化脚本预览',
      description:
        '按会话 IR 或显式传入的 IR 渲染 spec、page object 和 fixture；只预览文件，不写项目。',
      inputSchema: {
        sessionId: z.string(),
        ir: z.record(z.string(), z.unknown()).optional(),
        target: z.enum(['ts', 'python']).optional(),
        tag: z.string().optional(),
        hasBaseURL: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    protectedTool(async ({ sessionId, ir, target, tag, hasBaseURL }) => {
      const detail = await apiRequest(
        apiBase,
        `${UI_AUTO_API}/agent/session?id=${encodeURIComponent(sessionId)}`,
      );
      const effectiveIr = ir || detail.session?.ir;
      if (!effectiveIr) throw new BridgeError('会话还没有 IR；先探索并保存步骤', 409);
      return toolResult(
        await apiRequest(apiBase, `${UI_AUTO_API}/agent/emit`, {
          method: 'POST',
          body: {
            sessionId,
            projectId: detail.session?.projectId,
            ir: effectiveIr,
            target: target || detail.session?.target,
            tag,
            hasBaseURL: hasBaseURL ?? Boolean(detail.session?.baseURL),
          },
          timeoutMs: 60_000,
        }),
      );
    }),
  );

  server.registerTool(
    'lantern_uiauto_agent_verify',
    {
      title: '试跑 UI 自动化草稿',
      description:
        '把会话 IR 或显式文件写入隔离草稿并运行验证；失败保留 trace、日志和现场，不写正式项目。',
      inputSchema: {
        sessionId: z.string(),
        ir: z.record(z.string(), z.unknown()).optional(),
        files: z
          .array(
            z.object({
              path: z.string(),
              content: z.string(),
              role: z.string().optional(),
            }),
          )
          .optional(),
        timeoutMs: z.number().int().min(10_000).max(180_000).optional(),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    protectedTool(async (args) =>
      toolResult(
        await apiRequest(apiBase, `${UI_AUTO_API}/agent/verify`, {
          method: 'POST',
          body: args,
          timeoutMs: Math.max(30_000, Number(args.timeoutMs) || 180_000) + 10_000,
        }),
      ),
    ),
  );

  server.registerTool(
    'lantern_uiauto_agent_write',
    {
      title: '写入 UI 自动化测试项目',
      description:
        '把当前会话脚本合并进项目目标 iteration 文件；同 automationCaseId 只替换自己的测试块，保留其他用例。',
      inputSchema: {
        sessionId: z.string(),
        files: z
          .array(
            z.object({
              path: z.string(),
              content: z.string(),
              role: z.string().optional(),
              force: z.boolean().optional(),
            }),
          )
          .optional(),
        force: z.boolean().optional(),
      },
      annotations: { destructiveHint: true },
    },
    protectedTool(async (args) =>
      toolResult(
        await apiRequest(apiBase, `${UI_AUTO_API}/agent/write`, {
          method: 'POST',
          body: args,
          timeoutMs: 60_000,
        }),
      ),
    ),
  );

  server.registerTool(
    'lantern_uiauto_agent_close',
    {
      title: '结束 UI 自动化探索',
      description: '关闭受控浏览器并保存本轮控制台、网络和草稿摘要；会话与 Plan 保留。',
      inputSchema: { sessionId: z.string() },
      annotations: { destructiveHint: true },
    },
    protectedTool(async ({ sessionId }) =>
      toolResult(
        await apiRequest(apiBase, `${UI_AUTO_API}/agent/close`, {
          method: 'POST',
          body: { sessionId },
          timeoutMs: 30_000,
        }),
      ),
    ),
  );
  server.registerTool(
    'lantern_case_review_context',
    {
      title: '读取用例审查上下文',
      description: '读取用例文件、文件哈希、确定性覆盖与当前空间审查技能，生成审查后调用 save。',
      inputSchema: { casePath: z.string() },
      annotations: { readOnlyHint: true },
    },
    protectedTool(async ({ casePath }) => {
      const file = await apiRequest(
        apiBase,
        CASE_EXECUTION_API + '/cases?path=' + encodeURIComponent(casePath),
      );
      const entry = await findSpaceSkillByLegacy(apiBase, '用例质量评审提示词.md');
      if (!entry) throw new BridgeError('请先开启用例质量评审并准备技能', 422);
      return toolResult({
        ...file,
        skill: await readSpaceSkill(apiBase, entry.id),
        acceptance: await apiRequest(
          apiBase,
          '/__tb_case_design/acceptance?casePath=' + encodeURIComponent(casePath),
        ),
      });
    }),
  );
  server.registerTool(
    'lantern_case_review_save',
    {
      title: '保存用例审查报告',
      description: '文件哈希匹配后保存到页面同一份用例审查记录，不改用例正文。',
      inputSchema: {
        casePath: z.string(),
        expectedFileHash: z.string(),
        review: z.record(z.string(), z.unknown()),
      },
      annotations: { destructiveHint: true },
    },
    protectedTool(async ({ casePath, expectedFileHash, review }) =>
      toolResult(
        await apiRequest(apiBase, '/__tb_casereview/report', {
          method: 'PUT',
          body: { path: casePath, expectedHash: expectedFileHash, review },
        }),
      ),
    ),
  );
  server.registerTool(
    'lantern_case_acceptance',
    {
      title: '读取用例验收与覆盖报告',
      description:
        '按需求基线计算设计覆盖、执行与人工判定结果；列出失效基线、未覆盖、待验证和阻塞，不自动放行发布。',
      inputSchema: { casePath: z.string(), environmentKey: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    protectedTool(async ({ casePath, environmentKey = '' }) =>
      toolResult(
        await apiRequest(
          apiBase,
          '/__tb_case_design/acceptance?casePath=' +
            encodeURIComponent(casePath) +
            '&environmentKey=' +
            encodeURIComponent(environmentKey),
        ),
      ),
    ),
  );

  server.registerTool(
    'lantern_case_execution_prepare_columns',
    {
      title: '预览或补齐执行列',
      description: '先 preview，用户确认后 apply；备份后补齐状态和实际结果，不支持直接写回 XLS。',
      inputSchema: {
        casePath: z.string(),
        mode: z.enum(['preview', 'apply']),
        expectedFileHash: z.string().optional(),
      },
      annotations: { destructiveHint: true },
    },
    protectedTool(async (args) =>
      toolResult(
        await apiRequest(apiBase, CASE_EXECUTION_API + '/prepare-columns', {
          method: 'POST',
          body: args,
        }),
      ),
    ),
  );
  server.registerTool(
    'lantern_case_baseline_link',
    {
      title: '关联或更新用例需求基线',
      description:
        '先 preview，用户确认后 apply；保留历史结果并要求人工复核，不将旧通过自动计入新版本。',
      inputSchema: {
        casePath: z.string(),
        analysisId: z.string(),
        mode: z.enum(['preview', 'apply']),
        expectedFileHash: z.string().optional(),
        expectedRevision: z.string().optional(),
      },
      annotations: { destructiveHint: true },
    },
    protectedTool(async (args) =>
      toolResult(
        await apiRequest(apiBase, '/__tb_case_design/link', { method: 'POST', body: args }),
      ),
    ),
  );
  server.registerTool(
    'lantern_case_execution_plans',
    {
      title: '列出执行计划',
      description: '读取当前空间计划、环境、用例范围和中断状态。',
      inputSchema: { casePath: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    protectedTool(async ({ casePath = '' }) =>
      toolResult(
        await apiRequest(
          apiBase,
          CASE_EXECUTION_API + '/plans?path=' + encodeURIComponent(casePath),
        ),
      ),
    ),
  );
  server.registerTool(
    'lantern_case_execution_plan_create',
    {
      title: '创建执行计划',
      description:
        '仅创建用户明确指定范围的计划，不自动启动；浏览器串行或现有自动化项目，环境与构建必填，结果需人工判定。',
      inputSchema: {
        casePath: z.string(),
        expectedFileHash: z.string(),
        caseIds: z.array(z.string()).min(1),
        engine: z.enum(['browser', 'automation']),
        url: z.string().optional(),
        storageStatePath: z.string().optional(),
        allowedOrigins: z.array(z.string()).optional(),
        environment: z.object({
          name: z.string().min(1),
          build: z.string().min(1),
          role: z.string().optional(),
          dataNote: z.string().optional(),
        }),
        projectId: z.string().optional(),
        file: z.string().optional(),
        taskId: z.string().optional(),
        setupTaskId: z.string().optional(),
        cleanupTaskId: z.string().optional(),
      },
      annotations: { destructiveHint: true },
    },
    protectedTool(async (args) =>
      toolResult(
        await apiRequest(apiBase, CASE_EXECUTION_API + '/plans', { method: 'POST', body: args }),
      ),
    ),
  );
  server.registerTool(
    'lantern_case_execution_plan_result',
    {
      title: '人工验证计划用例结果',
      description:
        '用户核验报告后明确选择状态，校验计划范围与基线后继承该计划环境写回。不得由 AI 自行确认。',
      inputSchema: {
        planId: z.string(),
        caseId: z.string(),
        expectedFileHash: z.string(),
        status: z.enum(['待验证', '通过', '不通过', '阻塞', '跳过']),
        actualResult: z.string().min(1),
      },
      annotations: { destructiveHint: true },
    },
    protectedTool(async ({ planId, ...body }) =>
      toolResult(
        await apiRequest(
          apiBase,
          CASE_EXECUTION_API + '/plans/' + encodeURIComponent(planId) + '/result',
          { method: 'POST', body },
        ),
      ),
    ),
  );
  for (const action of ['get', 'start', 'stop'])
    server.registerTool(
      'lantern_case_execution_plan_' + action,
      {
        title: { get: '读取执行计划', start: '启动或继续执行计划', stop: '停止执行计划' }[action],
        description:
          action === 'start'
            ? '用户明确授权后执行已选择范围；继续仅处理未完成项，不自动写最终状态。'
            : '读取或停止当前计划并保留已有证据。',
        inputSchema: { planId: z.string() },
        annotations: { readOnlyHint: action === 'get', destructiveHint: action !== 'get' },
      },
      protectedTool(async ({ planId }) =>
        toolResult(
          await apiRequest(
            apiBase,
            CASE_EXECUTION_API +
              '/plans/' +
              encodeURIComponent(planId) +
              (action === 'get' ? '' : '/' + action),
            action === 'get' ? {} : { method: 'POST', body: {} },
          ),
        ),
      ),
    );

  server.registerTool(
    'lantern_case_execution_files',
    {
      title: '列出可执行用例文件',
      description: '列出用例管理中的用例文件、用例数量、是否具备状态和实际结果列。',
      annotations: { readOnlyHint: true },
    },
    protectedTool(async () => toolResult(await apiRequest(apiBase, `${CASE_EXECUTION_API}/files`))),
  );

  server.registerTool(
    'lantern_case_execution_cases',
    {
      title: '读取用例执行明细',
      description: '读取指定用例文件的字段、单条用例和当前执行状态。',
      inputSchema: { casePath: z.string() },
      annotations: { readOnlyHint: true },
    },
    protectedTool(async ({ casePath }) =>
      toolResult(
        await apiRequest(
          apiBase,
          `${CASE_EXECUTION_API}/cases?path=${encodeURIComponent(casePath)}`,
        ),
      ),
    ),
  );

  server.registerTool(
    'lantern_case_execution_login_start',
    {
      title: '打开用例执行登录页面',
      description: '打开目标系统登录窗口，由用户完成登录；工具不接收账号密码。',
      inputSchema: { url: z.string() },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    protectedTool(async ({ url }) =>
      toolResult(
        await apiRequest(apiBase, `${CASE_EXECUTION_API}/auth/start`, {
          method: 'POST',
          body: { url },
          timeoutMs: 60_000,
        }),
      ),
    ),
  );

  server.registerTool(
    'lantern_case_execution_login_complete',
    {
      title: '保存用例执行登录态',
      description: '用户完成登录后保存当前目标的浏览器 storageState。',
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    protectedTool(async () =>
      toolResult(
        await apiRequest(apiBase, `${CASE_EXECUTION_API}/auth/complete`, {
          method: 'POST',
          body: {},
          timeoutMs: 60_000,
        }),
      ),
    ),
  );

  server.registerTool(
    'lantern_case_execution_start',
    {
      title: '启动单条用例 AI 执行',
      description:
        '按用例文件路径和行号启动单条 AI 浏览器执行。只使用已有登录态路径，不接收账号密码。',
      inputSchema: {
        casePath: z.string(),
        rowIndex: z.number().int().nonnegative(),
        url: z.string(),
        storageStatePath: z.string().optional(),
        allowedOrigins: z.array(z.string()).optional(),
        environment: z
          .object({
            name: z.string(),
            role: z.string().optional(),
            build: z.string().optional(),
            dataNote: z.string().optional(),
          })
          .optional(),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    protectedTool(async (args) =>
      toolResult(
        await apiRequest(apiBase, `${CASE_EXECUTION_API}/runs`, {
          method: 'POST',
          body: args,
          timeoutMs: 60_000,
        }),
      ),
    ),
  );

  server.registerTool(
    'lantern_case_execution_get',
    {
      title: '读取用例执行会话',
      description: '读取单条用例执行状态、进度、事件和待确认结果。',
      inputSchema: { runId: z.string() },
      annotations: { readOnlyHint: true },
    },
    protectedTool(async ({ runId }) =>
      toolResult(
        await apiRequest(apiBase, `${CASE_EXECUTION_API}/runs/${encodeURIComponent(runId)}`),
      ),
    ),
  );

  server.registerTool(
    'lantern_case_execution_wait',
    {
      title: '等待用例执行回合',
      description: '轮询单条用例执行，直到结束或超时，并返回 afterSeq 之后的日志。',
      inputSchema: {
        runId: z.string(),
        timeoutMs: z.number().int().min(1000).max(55_000).optional(),
        afterSeq: z.number().int().nonnegative().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    protectedTool(async ({ runId, timeoutMs = 25_000, afterSeq = 0 }) =>
      toolResult(await waitForCaseExecution(apiBase, runId, timeoutMs, afterSeq)),
    ),
  );

  server.registerTool(
    'lantern_case_execution_stop',
    {
      title: '停止用例执行',
      description: '停止当前单条用例执行并保留已有日志和截图。',
      inputSchema: { runId: z.string() },
      annotations: { destructiveHint: true },
    },
    protectedTool(async ({ runId }) =>
      toolResult(
        await apiRequest(apiBase, `${CASE_EXECUTION_API}/runs/${encodeURIComponent(runId)}/stop`, {
          method: 'POST',
          body: {},
        }),
      ),
    ),
  );

  server.registerTool(
    'lantern_case_execution_apply',
    {
      title: '确认并写回用例执行结果',
      description:
        '用户确认后，把状态和实际结果写回用例文件已有的执行列；文件被外部修改时拒绝覆盖。',
      inputSchema: {
        runId: z.string(),
        status: z.enum(['待验证', '通过', '不通过', '阻塞', '跳过']),
        actualResult: z.string(),
        executor: z.string().optional(),
        expectedFileHash: z.string().optional(),
        defectNo: z.string().optional(),
      },
      annotations: { destructiveHint: true },
    },
    protectedTool(async ({ runId, ...values }) =>
      toolResult(
        await apiRequest(apiBase, `${CASE_EXECUTION_API}/runs/${encodeURIComponent(runId)}/apply`, {
          method: 'POST',
          body: values,
        }),
      ),
    ),
  );

  const statsDate = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((value) => {
      const date = new Date(value + 'T00:00:00Z');
      return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
    }, '日期必须为真实的 YYYY-MM-DD 日期');
  const statsDimension = z.string().trim().min(1).max(40);
  const statsCount = z.number().int().min(0).max(9_999_999);
  const statsRow = {
    date: statsDate,
    dimensions: z.array(statsDimension).length(1),
    count: statsCount,
  };
  server.registerTool(
    'lantern_test_stats_list',
    {
      title: '查询通用测试统计',
      description:
        '读取当前空间测试统计与维度，按日期区间、维度或关键词筛选并分维度/日期汇总；默认排除空占位草稿。返回 revision 供后续写入。',
      inputSchema: {
        from: statsDate.optional(),
        to: statsDate.optional(),
        dimension: statsDimension.optional(),
        query: z.string().optional(),
        includeDrafts: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    protectedTool(
      async ({ from = '', to = '', dimension = '', query = '', includeDrafts = false }) => {
        if (from && to && from > to) throw new BridgeError('开始日期不能晚于结束日期');
        const data = await apiRequest(apiBase, '/__tb_test_stats');
        const needle = query.trim().toLowerCase();
        const items = (data.items || [])
          .filter(
            (item) =>
              (includeDrafts || !item.draft) &&
              (!from || item.date >= from) &&
              (!to || item.date <= to) &&
              (!dimension || item.dimensions?.includes(dimension)) &&
              (!needle ||
                [item.date, ...(item.dimensions || []), item.count]
                  .join(' ')
                  .toLowerCase()
                  .includes(needle)),
          )
          .sort(
            (a, b) =>
              b.date.localeCompare(a.date) ||
              b.createdAt.localeCompare(a.createdAt) ||
              a.id.localeCompare(b.id),
          );
        const byDimension = new Map(),
          byDate = new Map();
        for (const item of items) {
          byDate.set(item.date, (byDate.get(item.date) || 0) + item.count);
          for (const name of item.dimensions || [])
            byDimension.set(name, (byDimension.get(name) || 0) + item.count);
        }
        return toolResult({
          ok: true,
          revision: data.revision,
          dimensions: data.dimensions,
          items,
          summary: {
            records: items.length,
            dimensions: byDimension.size,
            total: items.reduce((sum, item) => sum + item.count, 0),
            byDimension: [...byDimension].map(([dimension, count]) => ({ dimension, count })),
            byDate: [...byDate].map(([date, count]) => ({ date, count })),
          },
          scope: { from, to, dimension, query, includeDrafts },
          note: '统计数量合计沿用页面口径，不代表需求覆盖率或通过率。',
        });
      },
    ),
  );
  server.registerTool(
    'lantern_test_stats_create',
    {
      title: '新增通用测试统计',
      description:
        '按明确的日期、单个维度和数量新增记录；新维度自动加入选项。expectedRevision 使用最近一次查询/写入返回值，重试前先读取核验，避免重复新增。',
      inputSchema: {
        expectedRevision: z.string().min(1),
        items: z.array(z.object(statsRow)).min(1).max(100),
        sessionId: z.string().max(120).optional(),
      },
      annotations: { destructiveHint: true },
    },
    protectedTool(async (args) =>
      toolResult(
        await apiRequest(apiBase, '/__tb_test_stats', {
          method: 'POST',
          body: { ...args, mode: 'ai' },
        }),
      ),
    ),
  );
  server.registerTool(
    'lantern_test_stats_update',
    {
      title: '修改通用测试统计',
      description:
        '按真实记录 ID 增量修改已明确的字段，不传的字段保持不变；过期 revision 拒绝覆盖。',
      inputSchema: {
        expectedRevision: z.string().min(1),
        id: z.string().min(1),
        date: statsDate.optional(),
        dimensions: z.array(statsDimension).length(1).optional(),
        count: statsCount.optional(),
      },
      annotations: { destructiveHint: true },
    },
    protectedTool(async (args) => {
      if (args.date === undefined && args.dimensions === undefined && args.count === undefined)
        throw new BridgeError('至少提供一个要修改的字段');
      return toolResult(
        await apiRequest(apiBase, '/__tb_test_stats', { method: 'PUT', body: args }),
      );
    }),
  );
  server.registerTool(
    'lantern_test_stats_delete',
    {
      title: '删除通用测试统计',
      description: '仅按用户明确指定的记录 ID 删除，不把筛选条件直接转为批量清空。',
      inputSchema: {
        expectedRevision: z.string().min(1),
        ids: z.array(z.string().min(1)).min(1).max(100),
      },
      annotations: { destructiveHint: true },
    },
    protectedTool(async (args) =>
      toolResult(await apiRequest(apiBase, '/__tb_test_stats', { method: 'DELETE', body: args })),
    ),
  );
  server.registerTool(
    'lantern_test_stats_dimension_create',
    {
      title: '新增统计维度',
      description: '新增可用维度，不创建虚假统计记录；已有同名维度时返回当前选项。',
      inputSchema: { expectedRevision: z.string().min(1), name: statsDimension },
      annotations: { destructiveHint: true },
    },
    protectedTool(async (args) =>
      toolResult(
        await apiRequest(apiBase, '/__tb_test_stats/options', { method: 'POST', body: args }),
      ),
    ),
  );
  server.registerTool(
    'lantern_test_stats_dimension_rename',
    {
      title: '重命名统计维度',
      description: '同步修改引用该维度的记录；与已有维度同名时按页面规则合并选项。',
      inputSchema: {
        expectedRevision: z.string().min(1),
        from: statsDimension,
        to: statsDimension,
      },
      annotations: { destructiveHint: true },
    },
    protectedTool(async (args) =>
      toolResult(
        await apiRequest(apiBase, '/__tb_test_stats/options', { method: 'PUT', body: args }),
      ),
    ),
  );
  server.registerTool(
    'lantern_test_stats_dimension_delete',
    {
      title: '删除未使用的统计维度',
      description: '删除当前没有任何记录引用的维度；被引用时返回冲突及引用数量，不删除关联记录。',
      inputSchema: { expectedRevision: z.string().min(1), name: statsDimension },
      annotations: { destructiveHint: true },
    },
    protectedTool(async (args) =>
      toolResult(
        await apiRequest(apiBase, '/__tb_test_stats/options', { method: 'DELETE', body: args }),
      ),
    ),
  );

  server.registerTool(
    'lantern_case_execution_sync_stats',
    {
      title: '同步用例执行统计',
      description:
        '按用例文件生成统计预览，并在用户确认后同步到现有用例执行统计；已有手工统计不自动覆盖。',
      inputSchema: {
        casePath: z.string(),
        project: z.string(),
        date: z.string(),
        mode: z.enum(['preview', 'skip', 'overwrite']),
      },
      annotations: { destructiveHint: true },
    },
    protectedTool(async (args) =>
      toolResult(
        await apiRequest(apiBase, `${CASE_EXECUTION_API}/stats/sync`, {
          method: 'POST',
          body: args,
        }),
      ),
    ),
  );

  server.registerTool(
    'lantern_requirement_breakdown_list',
    {
      title: '需求拆解库列表',
      description:
        '列出实际 XMind 拆解文件及项目、迭代、来源、文件状态，可按关键词、项目、迭代和类型过滤。',
      inputSchema: {
        query: z.string().optional(),
        project: z.string().optional(),
        iteration: z.string().optional(),
        kind: z.enum(['generated', 'uploaded']).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    protectedTool(async ({ query = '', project = '', iteration = '', kind = '' }) => {
      const data = await loadRequirementBreakdownList(apiBase);
      const needle = String(query).trim().toLowerCase();
      const entries = data.entries.filter(
        (entry) =>
          (!project || entry.project === project) &&
          (!iteration || entry.iteration === iteration) &&
          (!kind || entry.kind === kind) &&
          (!needle ||
            [
              entry.title,
              entry.fileName,
              entry.project,
              entry.iteration,
              entry.sourceTitle,
              entry.sourcePath,
              entry.note,
            ]
              .join(' ')
              .toLowerCase()
              .includes(needle)),
      );
      return toolResult({
        ok: true,
        revision: data.revision,
        count: entries.length,
        entries,
      });
    }),
  );

  server.registerTool(
    'lantern_requirement_breakdown_get',
    {
      title: '读取需求拆解条目',
      description: '读取单条拆解库记录；可选解析最新 XMind 文件，返回层级文本和主题列表。',
      inputSchema: {
        entryId: z.string(),
        includeContent: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    protectedTool(async ({ entryId, includeContent = false }) => {
      const data = await apiRequest(
        apiBase,
        `${REQ_BREAKDOWN_API}/entries/${encodeURIComponent(entryId)}${includeContent ? '?includeContent=1' : ''}`,
      );
      return toolResult({ ok: true, ...data });
    }),
  );

  server.registerTool(
    'lantern_requirement_breakdown_import',
    {
      title: '导入需求拆解 XMind',
      description: '把 Codex 可访问的本地 .xmind 导入需求拆解库，按现有命名规则生成标题。',
      inputSchema: {
        filePath: z.string(),
        expectedRevision: z.number().int().nonnegative().optional(),
        project: z.string().optional(),
        iteration: z.string().optional(),
        note: z.string().optional(),
      },
      annotations: { destructiveHint: true },
    },
    protectedTool(async ({ filePath, expectedRevision, project, iteration, note }) => {
      const revision = await requireRequirementBreakdownRevision(apiBase, expectedRevision);
      const absolute = path.resolve(String(filePath || ''));
      const stat = fs.statSync(absolute);
      if (!stat.isFile() || !/\.xmind$/i.test(absolute))
        throw new BridgeError('filePath 必须是 .xmind 文件');
      const content = fs.readFileSync(absolute);
      return toolResult(
        await apiRequest(apiBase, `${REQ_BREAKDOWN_API}/import`, {
          method: 'POST',
          body: {
            name: path.basename(absolute),
            contentBase64: content.toString('base64'),
            expectedRevision: revision,
            ...(project ? { project } : {}),
            ...(iteration ? { iteration } : {}),
            ...(note ? { note } : {}),
          },
          timeoutMs: 60_000,
        }),
      );
    }),
  );

  server.registerTool(
    'lantern_requirement_breakdown_backfill_candidates',
    {
      title: '读取可补录历史分析',
      description:
        '列出已包含原文结构的需求分析，并标记是否已入库；用于选择 analysisIds 后再补录。',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    protectedTool(async () => {
      const data = await apiRequest(apiBase, `${REQ_BREAKDOWN_API}/backfill`);
      return toolResult({ ok: true, ...data });
    }),
  );

  server.registerTool(
    'lantern_requirement_breakdown_record_analysis',
    {
      title: '历史分析补录到拆解库',
      description: '从已有且包含原文结构的需求分析生成 XMind 文件并加入拆解库。',
      inputSchema: {
        analysisIds: z.array(z.string()).min(1),
        expectedRevision: z.number().int().nonnegative().optional(),
      },
      annotations: { destructiveHint: true },
    },
    protectedTool(async ({ analysisIds, expectedRevision }) => {
      const revision = await requireRequirementBreakdownRevision(apiBase, expectedRevision);
      return toolResult(
        await apiRequest(apiBase, `${REQ_BREAKDOWN_API}/backfill`, {
          method: 'POST',
          body: { analysisIds, expectedRevision: revision },
          timeoutMs: 90_000,
        }),
      );
    }),
  );

  server.registerTool(
    'lantern_requirement_breakdown_retry',
    {
      title: '重新生成需求拆解 XMind',
      description: '按原需求分析重新生成缺失或损坏的自动拆解文件。',
      inputSchema: {
        entryId: z.string(),
        expectedRevision: z.number().int().nonnegative().optional(),
      },
      annotations: { destructiveHint: true },
    },
    protectedTool(async ({ entryId, expectedRevision }) => {
      const revision = await requireRequirementBreakdownRevision(apiBase, expectedRevision);
      return toolResult(
        await apiRequest(
          apiBase,
          `${REQ_BREAKDOWN_API}/entries/${encodeURIComponent(entryId)}/retry`,
          { method: 'POST', body: { expectedRevision: revision }, timeoutMs: 60_000 },
        ),
      );
    }),
  );

  server.registerTool(
    'lantern_requirement_breakdown_update',
    {
      title: '修改需求拆解条目',
      description: '修改拆解库条目的标题或备注；标题变更会同步重命名本地 XMind。',
      inputSchema: {
        entryId: z.string(),
        expectedRevision: z.number().int().nonnegative().optional(),
        title: z.string().optional(),
        note: z.string().optional(),
      },
      annotations: { destructiveHint: true },
    },
    protectedTool(async ({ entryId, expectedRevision, title, note }) => {
      const revision = await requireRequirementBreakdownRevision(apiBase, expectedRevision);
      return toolResult(
        await apiRequest(apiBase, `${REQ_BREAKDOWN_API}/entries/${encodeURIComponent(entryId)}`, {
          method: 'PUT',
          body: {
            expectedRevision: revision,
            ...(title !== undefined ? { title } : {}),
            ...(note !== undefined ? { note } : {}),
          },
        }),
      );
    }),
  );

  server.registerTool(
    'lantern_requirement_breakdown_open',
    {
      title: '本地打开需求拆解 XMind',
      description: '用系统默认 XMind 程序打开拆解库条目。',
      inputSchema: { entryId: z.string() },
      annotations: { openWorldHint: true },
    },
    protectedTool(async ({ entryId }) =>
      toolResult(
        await apiRequest(
          apiBase,
          `${REQ_BREAKDOWN_API}/entries/${encodeURIComponent(entryId)}/open`,
          { method: 'POST', body: {} },
        ),
      ),
    ),
  );

  server.registerTool(
    'lantern_requirement_breakdown_delete',
    {
      title: '删除需求拆解条目',
      description: '删除拆解库记录，并把对应 XMind 文件移入系统废纸篓。',
      inputSchema: {
        entryId: z.string(),
        expectedRevision: z.number().int().nonnegative().optional(),
      },
      annotations: { destructiveHint: true },
    },
    protectedTool(async ({ entryId, expectedRevision }) => {
      const revision = await requireRequirementBreakdownRevision(apiBase, expectedRevision);
      return toolResult(
        await apiRequest(apiBase, `${REQ_BREAKDOWN_API}/entries/${encodeURIComponent(entryId)}`, {
          method: 'DELETE',
          body: { expectedRevision: revision },
        }),
      );
    }),
  );

  server.registerTool(
    'lantern_mcp_tools',
    {
      title: '查询 Lantern 外接 MCP 工具',
      description:
        '发现当前 Lantern 活动空间已连接的外接 MCP 工具（包括腾讯文档），返回真实工具名、inputSchema、说明和连接错误。可按服务器或关键词筛选。先读取参数定义，再用 lantern_mcp_call 调用；不需要另配连接器或复制凭据。',
      inputSchema: {
        server: z.string().optional().describe('服务器名称，例如 tencent-docs'),
        query: z.string().optional().describe('工具名或说明中的关键词'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    protectedTool(async ({ server: serverName, query }) => {
      const data = await apiRequest(apiBase, '/__tb_mcp/tools', { timeoutMs: 90_000 });
      const keyword = String(query || '')
        .trim()
        .toLowerCase();
      const tools = (data.tools || []).filter(
        (tool) =>
          (!serverName || tool.server === serverName) &&
          (!keyword || `${tool.name} ${tool.description || ''}`.toLowerCase().includes(keyword)),
      );
      return toolResult({ ...data, tools, count: tools.length });
    }),
  );

  server.registerTool(
    'lantern_mcp_call',
    {
      title: '调用 Lantern 外接 MCP 工具',
      description:
        '通过 Lantern 现有连接调用当前活动空间的外接 MCP，复用该空间凭据和远端权限。必须先用 lantern_mcp_tools 查询真实名称及 inputSchema；arguments 按该定义填写。支持读取和写入，写入须符合用户授权；缺陷提交优先走 lantern_defect_* 草稿和回执流程。返回远端原始内容、结构化结果或错误，不自动重试。',
      inputSchema: {
        name: z.string().min(1).describe('lantern_mcp_tools 返回的完整工具名'),
        arguments: z.record(z.string(), z.unknown()).default({}),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    protectedTool(async ({ name, arguments: args }) => {
      // 重新发现以服从活动空间和配置变化，不允许猜名称绕过当前工具目录。
      const listed = await apiRequest(apiBase, '/__tb_mcp/tools', { timeoutMs: 90_000 });
      if (!(listed.tools || []).some((tool) => tool.name === name)) {
        throw new BridgeError('当前空间没有这个 MCP 工具；请重新调用 lantern_mcp_tools', 404, {
          errors: listed.errors || [],
        });
      }
      let result;
      try {
        result = await apiRequest(apiBase, '/__tb_mcp/call', {
          method: 'POST',
          body: { name, arguments: args },
          timeoutMs: 90_000,
        });
      } catch (error) {
        if (!(error instanceof BridgeError) || !error.details?.isError) throw error;
        result = error.details;
      }
      return {
        content: Array.isArray(result.content)
          ? result.content
          : [{ type: 'text', text: result.text || JSON.stringify(result) }],
        ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
        isError: Boolean(result.isError || result.ok === false),
      };
    }),
  );

  server.registerTool(
    'lantern_requirement_prepare',
    {
      title: '准备需求分析工作区',
      description:
        '启用需求文档库、需求分析、用户故事审查和测试点插件，补种技能并迁移为当前空间技能。首次导入或分析需求前调用；重复调用无副作用。',
      annotations: { destructiveHint: true },
    },
    protectedTool(async () => {
      const prepared = await prepareRequirementWorkflow(apiBase);
      return toolResult(
        { ok: true, ...prepared },
        prepared.changed ? '已准备需求分析工作区。' : '需求分析工作区已就绪。',
      );
    }),
  );

  server.registerTool(
    'lantern_skill_list',
    {
      title: '列出技能',
      description: '列出当前空间技能、内部变体、启用状态、插件推荐关系和版本。',
      inputSchema: {
        query: z.string().optional().describe('按名称、描述或变体过滤'),
        includeDisabled: z.boolean().optional().describe('是否包含已停用技能，默认 false'),
      },
      annotations: { readOnlyHint: true },
    },
    protectedTool(async ({ query = '', includeDisabled = false }) => {
      const needle = String(query).trim().toLowerCase();
      const skills = (await listSpaceSkills(apiBase)).filter(
        (item) =>
          (includeDisabled || item.active !== false) &&
          (!needle ||
            `${item.name} ${item.variant} ${item.description}`.toLowerCase().includes(needle)),
      );
      return toolResult({ ok: true, count: skills.length, skills });
    }),
  );

  server.registerTool(
    'lantern_skill_load',
    {
      title: '加载技能',
      description: '按技能 ID 或当前空间内旧提示词路径加载完整技能规则与流程。',
      inputSchema: {
        id: z.string().optional().describe('技能 ID，可带 space: 前缀'),
        legacyPath: z.string().optional().describe('旧提示词文件名，例如 需求分析提示词.md'),
      },
      annotations: { readOnlyHint: true },
    },
    protectedTool(async ({ id = '', legacyPath = '' }) => {
      let resolved = id;
      if (!resolved && legacyPath) {
        const entry = await findSpaceSkillByLegacy(apiBase, legacyPath);
        if (!entry) throw new BridgeError(`未找到技能：${legacyPath}`, 404);
        resolved = entry.id;
      }
      if (!resolved) throw new BridgeError('id 或 legacyPath 至少需要一个');
      return toolResult({ ok: true, skill: await readSpaceSkill(apiBase, resolved) });
    }),
  );

  server.registerTool(
    'lantern_skill_validate',
    {
      title: '校验技能输出',
      description:
        '使用 Lantern 技能校验器检查 rows、columns、sourceIds、编号、优先级、统计和章节等结构。',
      inputSchema: {
        id: z.string().describe('技能 ID'),
        input: z.record(z.string(), z.unknown()).describe('待校验的 JSON'),
      },
      annotations: { readOnlyHint: true },
    },
    protectedTool(async ({ id, input }) => {
      const data = await apiRequest(apiBase, SKILL_API, {
        method: 'POST',
        body: { action: 'validate', id, input },
      });
      return toolResult(data);
    }),
  );

  server.registerTool(
    'lantern_requirement_list',
    {
      title: '需求文档列表',
      description: '列出 Lantern 需求文档库中的文件夹与文件。',
      inputSchema: {
        path: z.string().optional().describe('相对目录，默认根目录'),
      },
      annotations: { readOnlyHint: true },
    },
    protectedTool(async ({ path: parent = '.' }) => {
      const entries = await listRequirementEntries(apiBase, parent);
      return toolResult({ ok: true, path: parent, entries });
    }),
  );

  server.registerTool(
    'lantern_requirement_import',
    {
      title: '导入需求文档',
      description:
        '把 Codex 可访问的本地需求文档复制到 Lantern 需求文档库。支持 md、txt、docx、csv、xlsx、xls。',
      inputSchema: {
        filePath: z.string().describe('本地文件绝对路径'),
        folder: z.string().optional().describe('需求文档库内相对目录，默认根目录'),
        overwrite: z.boolean().optional().describe('同名时是否覆盖，默认 false'),
      },
      annotations: { destructiveHint: true },
    },
    protectedTool(async ({ filePath, folder = '.', overwrite = false }) => {
      const absolute = path.resolve(String(filePath || ''));
      const stat = fs.statSync(absolute);
      if (!stat.isFile()) throw new BridgeError('filePath 不是文件');
      if (stat.size > MAX_IMPORT_BYTES) throw new BridgeError('需求文档超过 12MB');
      const ext = path.extname(absolute).toLowerCase();
      if (!ALLOWED_REQUIREMENT_EXT.has(ext)) {
        throw new BridgeError(`不支持的需求文档类型：${ext || '(无扩展名)'}`);
      }
      let name = path.basename(absolute);
      const entries = await listRequirementEntries(apiBase, folder);
      if (entries.some((entry) => entry.name === name) && !overwrite) {
        name = uniqueUploadName(entries, name, ext);
      }
      const content = fs.readFileSync(absolute);
      const uploaded = await apiRequest(apiBase, `/${DOC_API.slice(1)}/upload`, {
        method: 'POST',
        body: {
          name,
          parent: folder,
          contentBase64: content.toString('base64'),
        },
        timeoutMs: 60_000,
      });
      return toolResult({
        ok: true,
        sourcePath: uploaded.path,
        originalPath: absolute,
        name,
        size: content.length,
        sha256: sha256(content),
        renamed: name !== path.basename(absolute),
      });
    }),
  );

  server.registerTool(
    'lantern_requirement_sources',
    {
      title: '可分析需求来源',
      description: '列出需求分析可选择的需求文档及格式支持情况。',
      annotations: { readOnlyHint: true },
    },
    protectedTool(async () => {
      const data = await apiRequest(apiBase, `/${REQ_API.slice(1)}/sources`);
      return toolResult(data);
    }),
  );

  server.registerTool(
    'lantern_requirement_context',
    {
      title: '需求拆解上下文',
      description:
        '读取需求源文、需求分析技能和原文结构技能。调用后应由客户端模型生成 outline 与 stories，再调用 lantern_requirement_analysis_save。',
      inputSchema: {
        sourcePath: z.string().optional().describe('需求文档库内相对路径'),
        analysisId: z.string().optional().describe('已有分析 ID，可替代 sourcePath'),
        maxChars: z.number().int().min(1000).max(120000).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    protectedTool(async ({ sourcePath = '', analysisId = '', maxChars = DEFAULT_SOURCE_CHARS }) => {
      const analysis = await findAnalysis(apiBase, { analysisId, sourcePath });
      if (analysisId && !analysis) throw new BridgeError('未找到需求分析', 404);
      const resolvedPath = sourcePath || analysis?.sourcePath;
      if (!resolvedPath) throw new BridgeError('未找到需求分析或来源文档', 404);
      const [source, analysisSkill, outlineSkill] = await Promise.all([
        readRequirementSource(apiBase, resolvedPath),
        withAnalysisSkillContext(apiBase, '需求分析提示词.md'),
        withAnalysisSkillContext(apiBase, '原文结构提示词.md'),
      ]);
      const content = String(source.content || '');
      const limit = Math.max(1000, Math.min(Number(maxChars) || DEFAULT_SOURCE_CHARS, 120000));
      return toolResult({
        ok: true,
        sourcePath: resolvedPath,
        sourceTitle: path.basename(resolvedPath),
        sourceHash: sha256(content),
        sourceFormat: source.format || path.extname(resolvedPath).slice(1),
        sourceTruncated: content.length > limit,
        content: content.slice(0, limit),
        existingAnalysisId: analysis?.id || '',
        existingAnalysisRevision: analysis ? analysisRevision(analysis) : '',
        existingAnalysisUpdatedAt: analysis?.updatedAt || '',
        skills: {
          analysis: {
            id: analysisSkill.id,
            version: analysisSkill.version,
            instructions: analysisSkill.instructions,
            rules: analysisSkill.content,
          },
          outline: {
            id: outlineSkill.id,
            version: outlineSkill.version,
            instructions: outlineSkill.instructions,
            rules: outlineSkill.content,
          },
        },
        nextTool: 'lantern_requirement_analysis_save',
        outputContract: {
          outline: [{ id: 'RO-1', title: '来源条目标题', quote: '原文证据' }],
          stories: [
            {
              id: '可省略；新故事由 Lantern 分配',
              title: '用户故事标题',
              role: '角色',
              goal: '目标',
              value: '业务价值',
              sourceRefs: ['RO-1'],
              priority: 'P0|P1|P2',
              preconditions: ['前置条件'],
              mainFlow: [{ actor: '角色', action: '动作', result: '结果' }],
              altFlows: [{ name: '替代流程', trigger: '触发条件', steps: ['步骤'] }],
              exceptions: [{ scenario: '异常场景', expected: '预期' }],
              postconditions: ['后置条件'],
              acceptance: [{ given: '前提', when: '操作', then: '结果' }],
              dimensions: ['functional'],
            },
          ],
        },
      });
    }),
  );

  server.registerTool(
    'lantern_requirement_analysis_get',
    {
      title: '读取需求分析',
      description: '按 analysisId 或 sourcePath 读取当前空间的需求分析完整记录。',
      inputSchema: {
        analysisId: z.string().optional(),
        sourcePath: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    protectedTool(async ({ analysisId = '', sourcePath = '' }) => {
      const analysis = await findAnalysis(apiBase, { analysisId, sourcePath });
      if (!analysis) throw new BridgeError('需求分析不存在', 404);
      return toolResult({
        ok: true,
        analysis,
        revision: analysisRevision(analysis),
        artifactUrl: artifactUrl(apiBase, analysis),
      });
    }),
  );

  server.registerTool(
    'lantern_requirement_analysis_list',
    {
      title: '需求分析列表',
      description: '列出当前空间已有需求分析，返回 ID、标题、来源、状态、故事数和 revision。',
      inputSchema: {
        query: z.string().optional().describe('按标题、来源路径或状态过滤'),
      },
      annotations: { readOnlyHint: true },
    },
    protectedTool(async ({ query = '' }) => {
      const needle = String(query).trim().toLowerCase();
      const docs = (await requirementDocs(apiBase)).filter((doc) => {
        if (!needle) return true;
        return [doc.id, doc.title, doc.sourceTitle, doc.sourcePath, doc.status]
          .join(' ')
          .toLowerCase()
          .includes(needle);
      });
      return toolResult({
        ok: true,
        count: docs.length,
        analyses: docs.map((doc) => ({
          id: doc.id,
          title: doc.title || '',
          sourceTitle: doc.sourceTitle || '',
          sourcePath: doc.sourcePath || '',
          status: doc.status || '',
          storyCount: Array.isArray(doc.stories) ? doc.stories.length : 0,
          outlineCount: Array.isArray(doc.outline) ? doc.outline.length : 0,
          testPointCount: Array.isArray(doc.testPoints?.points) ? doc.testPoints.points.length : 0,
          updatedAt: doc.updatedAt || '',
          revision: analysisRevision(doc),
          artifactUrl: artifactUrl(apiBase, doc),
        })),
      });
    }),
  );

  server.registerTool(
    'lantern_requirement_analysis_delete',
    {
      title: '删除需求分析',
      description:
        '批量删除需求分析记录。只删除分析数据，不删除需求源文或已存在的需求拆解 XMind 文件。',
      inputSchema: {
        analysisIds: z.array(z.string()).min(1),
      },
      annotations: { destructiveHint: true },
    },
    protectedTool(async ({ analysisIds }) =>
      toolResult(
        await apiRequest(apiBase, `/${REQ_API.slice(1)}/delete`, {
          method: 'POST',
          body: { ids: analysisIds },
        }),
      ),
    ),
  );

  server.registerTool(
    'lantern_requirement_analysis_save',
    {
      title: '保存需求拆解',
      description:
        '保存或更新需求原文结构和用户故事。故事 ID、白名单字段和测试点失效规则由 Lantern 服务端处理。',
      inputSchema: {
        analysisId: z.string().optional(),
        sourcePath: z.string().optional(),
        title: z.string().optional(),
        sourceTitle: z.string().optional(),
        sourceHash: z.string().optional(),
        expectedRevision: z
          .string()
          .optional()
          .describe('更新已有分析时必填；来自 analysis_get 或 requirement_context'),
        outline: z.array(z.record(z.string(), z.unknown())).optional(),
        stories: z.array(z.record(z.string(), z.unknown())).describe('用户故事数组'),
        replaceStories: z.boolean().optional(),
        summary: z.string().optional(),
        status: z.string().optional(),
      },
      annotations: { destructiveHint: true },
    },
    protectedTool(async (args) => {
      const existing = await findAnalysis(apiBase, args);
      if (args.analysisId && !existing) {
        throw new BridgeError(`需求分析不存在：${args.analysisId}`, 404);
      }
      if (existing) requireExpectedRevision(existing, args.expectedRevision);
      const body = {
        ...(existing?.id ? { id: existing.id } : {}),
        ...(args.expectedRevision ? { expectedRevision: args.expectedRevision } : {}),
        ...(args.sourcePath ? { sourcePath: args.sourcePath } : {}),
        ...(args.title ? { title: args.title } : {}),
        ...(args.sourceTitle ? { sourceTitle: args.sourceTitle } : {}),
        ...(args.sourceHash ? { sourceHash: args.sourceHash } : {}),
        ...(args.outline ? { outline: args.outline } : {}),
        stories: args.stories,
        replaceStories: args.replaceStories !== false,
        ...(args.summary ? { summary: args.summary } : {}),
        ...(args.status ? { status: args.status } : {}),
      };
      if (!existing && !body.sourcePath) {
        throw new BridgeError('新建需求分析需要 sourcePath');
      }
      if (!existing && !body.sourceHash) {
        throw new BridgeError('新建需求分析需要 sourceHash；请先调用 lantern_requirement_context');
      }
      const sourcePathToCheck = body.sourcePath || existing?.sourcePath || '';
      if (body.sourceHash && sourcePathToCheck) {
        const source = await readRequirementSource(apiBase, sourcePathToCheck);
        const currentHash = sha256(String(source.content || ''));
        if (body.sourceHash !== currentHash) {
          throw new BridgeError('来源文档已更新，请重新读取需求上下文后再保存', 409, {
            sourcePath: sourcePathToCheck,
            expectedSourceHash: body.sourceHash,
            currentSourceHash: currentHash,
          });
        }
      }
      const data = existing
        ? await apiRequest(apiBase, `/${REQ_API.slice(1)}`, { method: 'PUT', body })
        : await apiRequest(apiBase, `/${REQ_API.slice(1)}/create`, { method: 'POST', body });
      return toolResult(
        {
          ok: true,
          analysisId: data.doc.id,
          revision: data.revision || analysisRevision(data.doc),
          updatedAt: data.doc.updatedAt || '',
          storyCount: data.doc.stories?.length || 0,
          outlineCount: data.doc.outline?.length || 0,
          artifactUrl: artifactUrl(apiBase, data.doc),
          doc: data.doc,
        },
        `已保存 ${data.doc.stories?.length || 0} 条用户故事。`,
      );
    }),
  );

  server.registerTool(
    'lantern_requirement_story_patch',
    {
      title: '修改单个用户故事',
      description:
        '按 storyId 增量修改一条用户故事，其他故事保持不变。必须提供最新 expectedRevision，避免覆盖 Lantern 页面中的并发编辑。',
      inputSchema: {
        analysisId: z.string(),
        storyId: z.string(),
        expectedRevision: z.string().describe('来自 analysis_get 或 requirement_context'),
        patch: z.record(z.string(), z.unknown()).describe('要覆盖的故事字段；不能修改 id'),
      },
      annotations: { destructiveHint: true },
    },
    protectedTool(async ({ analysisId, storyId, expectedRevision, patch }) => {
      const analysis = await findAnalysis(apiBase, { analysisId });
      if (!analysis) throw new BridgeError('需求分析不存在', 404);
      requireExpectedRevision(analysis, expectedRevision);
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new BridgeError('patch 必须是对象');
      }
      if (Object.keys(patch).length === 0) throw new BridgeError('patch 不能为空');
      if ('id' in patch && patch.id !== storyId) {
        throw new BridgeError('不能通过 patch 修改 storyId');
      }
      const stories = Array.isArray(analysis.stories) ? analysis.stories : [];
      const index = stories.findIndex((story) => story.id === storyId);
      if (index < 0) throw new BridgeError(`用户故事不存在：${storyId}`, 404);
      const nextStory = { ...stories[index], ...patch, id: storyId };
      const nextStories = stories.map((story, i) => (i === index ? nextStory : story));
      const data = await apiRequest(apiBase, `/${REQ_API.slice(1)}`, {
        method: 'PUT',
        body: { id: analysisId, expectedRevision, stories: nextStories },
      });
      return toolResult({
        ok: true,
        analysisId,
        revision: data.revision || analysisRevision(data.doc),
        updatedAt: data.doc.updatedAt || '',
        story: data.doc.stories?.find((story) => story.id === storyId) || nextStory,
        testPointsNeedReview: Boolean(data.doc.testPoints?.points?.length),
        artifactUrl: artifactUrl(apiBase, data.doc),
      });
    }),
  );

  server.registerTool(
    'lantern_requirement_story_delete',
    {
      title: '删除单个用户故事',
      description:
        '按 storyId 删除一条用户故事，并移除引用该故事的测试点。必须提供最新 expectedRevision。',
      inputSchema: {
        analysisId: z.string(),
        storyId: z.string(),
        expectedRevision: z.string().describe('来自 analysis_get 或 requirement_context'),
      },
      annotations: { destructiveHint: true },
    },
    protectedTool(async ({ analysisId, storyId, expectedRevision }) => {
      const analysis = await findAnalysis(apiBase, { analysisId });
      if (!analysis) throw new BridgeError('需求分析不存在', 404);
      requireExpectedRevision(analysis, expectedRevision);
      const stories = Array.isArray(analysis.stories) ? analysis.stories : [];
      if (!stories.some((story) => story.id === storyId)) {
        throw new BridgeError(`用户故事不存在：${storyId}`, 404);
      }
      const nextStories = stories.filter((story) => story.id !== storyId);
      const points = Array.isArray(analysis.testPoints?.points) ? analysis.testPoints.points : [];
      const nextPoints = points.filter((point) => point.storyId !== storyId);
      const removedPointCount = points.length - nextPoints.length;
      const body = { id: analysisId, expectedRevision, stories: nextStories };
      if (removedPointCount) {
        body.testPoints =
          nextPoints.length || analysis.testPoints?.summary
            ? {
                ...analysis.testPoints,
                at: new Date().toISOString(),
                points: nextPoints,
              }
            : null;
      }
      const data = await apiRequest(apiBase, `/${REQ_API.slice(1)}`, {
        method: 'PUT',
        body,
      });
      return toolResult({
        ok: true,
        analysisId,
        deletedStoryId: storyId,
        removedPointCount,
        revision: data.revision || analysisRevision(data.doc),
        updatedAt: data.doc.updatedAt || '',
        storyCount: data.doc.stories?.length || 0,
        reviewNeedsRefresh: Boolean(data.doc.check),
        artifactUrl: artifactUrl(apiBase, data.doc),
      });
    }),
  );

  server.registerTool(
    'lantern_requirement_review_save',
    {
      title: '保存故事审查',
      description: '保存用户故事审查报告、待确认缺口和忽略项，不修改故事正文。',
      inputSchema: {
        analysisId: z.string(),
        expectedRevision: z.string().describe('来自 analysis_get'),
        check: z.record(z.string(), z.unknown()),
        ignoredGaps: z.array(z.record(z.string(), z.unknown())).optional(),
        status: z.string().optional(),
      },
      annotations: { destructiveHint: true },
    },
    protectedTool(async ({ analysisId, expectedRevision, check, ignoredGaps, status }) => {
      const analysis = await findAnalysis(apiBase, { analysisId });
      if (!analysis) throw new BridgeError('需求分析不存在', 404);
      requireExpectedRevision(analysis, expectedRevision);
      const data = await apiRequest(apiBase, `/${REQ_API.slice(1)}`, {
        method: 'PUT',
        body: {
          id: analysisId,
          expectedRevision,
          check,
          ...(ignoredGaps ? { ignoredGaps } : {}),
          ...(status ? { status } : {}),
        },
      });
      return toolResult({
        ok: true,
        analysisId,
        revision: data.revision || analysisRevision(data.doc),
        updatedAt: data.doc.updatedAt || '',
        gapCount: data.doc.check?.gaps?.length || 0,
        artifactUrl: artifactUrl(apiBase, data.doc),
      });
    }),
  );

  server.registerTool(
    'lantern_requirement_review_context',
    {
      title: '故事审查上下文',
      description:
        '读取最新用户故事、来源正文和 Lantern 故事审查技能。生成审查结果后调用 lantern_requirement_review_save。',
      inputSchema: {
        analysisId: z.string(),
        maxChars: z.number().int().min(1000).max(120000).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    protectedTool(async ({ analysisId, maxChars = DEFAULT_SOURCE_CHARS }) => {
      const analysis = await findAnalysis(apiBase, { analysisId });
      if (!analysis) throw new BridgeError('需求分析不存在', 404);
      if (!analysis.stories?.length) throw new BridgeError('请先生成并保存用户故事');
      const [source, reviewSkill] = await Promise.all([
        readRequirementSource(apiBase, analysis.sourcePath),
        withAnalysisSkillContext(apiBase, '用户故事审查提示词.md'),
      ]);
      const content = String(source.content || '');
      const limit = Math.max(1000, Math.min(Number(maxChars) || DEFAULT_SOURCE_CHARS, 120000));
      return toolResult({
        ok: true,
        analysisId,
        revision: analysisRevision(analysis),
        updatedAt: analysis.updatedAt || '',
        sourcePath: analysis.sourcePath,
        sourceHash: sha256(content),
        sourceTruncated: content.length > limit,
        content: content.slice(0, limit),
        outline: analysis.outline || [],
        stories: analysis.stories,
        existingCheck: analysis.check || null,
        skill: {
          id: reviewSkill.id,
          version: reviewSkill.version,
          instructions: reviewSkill.instructions,
          rules: reviewSkill.content,
        },
        nextTool: 'lantern_requirement_review_save',
        outputContract: {
          check: {
            summary: '审查总体结论',
            coverage: { total: 0, covered: 0, rate: 0 },
            dimensions: [
              {
                key: 'functional',
                label: '功能',
                covered: true,
                stories: ['US-001'],
              },
            ],
            gaps: [
              {
                storyId: 'US-001',
                type: 'uncovered-outline|pending-confirm|missing-field|missing-scenario|missing-dimension|untestable-acceptance|conflict|over-split|other',
                severity: 'high|medium|low',
                title: '缺口标题',
                detail: '缺口说明',
                suggestion: '建议怎么补',
                origin: 'rule|model',
                selected: true,
              },
            ],
          },
        },
      });
    }),
  );

  server.registerTool(
    'lantern_testpoints_context',
    {
      title: '测试点生成上下文',
      description:
        '读取指定需求分析、用户故事和测试点技能。调用后生成 testPoints 对象并调用 lantern_testpoints_save。',
      inputSchema: {
        analysisId: z.string(),
      },
      annotations: { readOnlyHint: true },
    },
    protectedTool(async ({ analysisId }) => {
      const analysis = await findAnalysis(apiBase, { analysisId });
      if (!analysis) throw new BridgeError('需求分析不存在', 404);
      if (!analysis.stories?.length) throw new BridgeError('请先生成并保存用户故事');
      const skill = await withAnalysisSkillContext(apiBase, '测试点生成提示词.md');
      return toolResult({
        ok: true,
        analysisId,
        sourcePath: analysis.sourcePath,
        outline: analysis.outline || [],
        stories: analysis.stories,
        revision: analysisRevision(analysis),
        updatedAt: analysis.updatedAt || '',
        existingTestPoints: analysis.testPoints || null,
        skill: {
          id: skill.id,
          version: skill.version,
          instructions: skill.instructions,
          rules: skill.content,
        },
        nextTool: 'lantern_testpoints_save',
        outputContract: {
          summary: '测试点总体说明',
          points: [
            {
              storyId: 'US-001',
              dimension: 'functional|boundary|exception|business|nonfunctional',
              priority: 'P0|P1|P2|P3',
              title: '测试点',
              precondition: '前置条件',
              steps: ['步骤'],
              expected: '预期',
              supplemental: false,
            },
          ],
        },
      });
    }),
  );

  server.registerTool(
    'lantern_testpoints_save',
    {
      title: '保存测试点',
      description: '把测试点报告保存到指定需求分析；Lantern 会排序、重编号并做白名单归一化。',
      inputSchema: {
        analysisId: z.string(),
        expectedRevision: z.string().describe('来自 testpoints_context 或 analysis_get'),
        testPoints: z.record(z.string(), z.unknown()),
      },
      annotations: { destructiveHint: true },
    },
    protectedTool(async ({ analysisId, expectedRevision, testPoints }) => {
      const analysis = await findAnalysis(apiBase, { analysisId });
      if (!analysis) throw new BridgeError('需求分析不存在', 404);
      requireExpectedRevision(analysis, expectedRevision);
      const data = await apiRequest(apiBase, `/${REQ_API.slice(1)}`, {
        method: 'PUT',
        body: { id: analysisId, expectedRevision, testPoints },
      });
      return toolResult({
        ok: true,
        analysisId,
        revision: data.revision || analysisRevision(data.doc),
        updatedAt: data.doc.updatedAt || '',
        pointCount: data.doc.testPoints?.points?.length || 0,
        artifactUrl: artifactUrl(apiBase, data.doc),
      });
    }),
  );

  server.registerTool(
    'lantern_defect_templates',
    {
      title: '列出缺陷规则',
      description: '列出当前空间保存的缺陷规则及当前选中模板。',
      annotations: { readOnlyHint: true },
    },
    protectedTool(async () => toolResult(await apiRequest(apiBase, DEFECT_API + '/templates'))),
  );
  server.registerTool(
    'lantern_defect_rule_inspect',
    {
      title: '识别缺陷目标字段',
      description:
        '只读检查腾讯文档缺陷目标或子表，返回可选子表和真实字段；其他平台可创建手动字段规则。',
      inputSchema: {
        url: z.string(),
        sheetId: z.string().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    protectedTool(async (args) =>
      toolResult(
        await apiRequest(apiBase, DEFECT_API + '/inspect', {
          method: 'POST',
          body: args,
          timeoutMs: 90_000,
        }),
      ),
    ),
  );
  server.registerTool(
    'lantern_defect_rule_save',
    {
      title: '新建或修改缺陷规则',
      description:
        '保存缺陷规则的入口、字段映射、填写口径、默认值、必填状态和迭代配置。字段 ID 必须来自 inspect 或已有规则。',
      inputSchema: {
        id: z.string().optional().describe('为空时新建规则'),
        name: z.string().min(1),
        url: z.string().optional(),
        sheetId: z.string().optional(),
        template: z.string().optional(),
        mapping: z
          .array(
            z.object({
              id: z.string(),
              label: z.string(),
              required: z.boolean().optional(),
              source: z.enum(['remote', 'manual']).optional(),
              rule: z.string().optional(),
              kind: z
                .enum(['text', 'number', 'option', 'bool', 'reference', 'image', 'attachment'])
                .optional(),
              multiple: z.boolean().optional(),
              options: z.array(z.object({ id: z.string(), label: z.string() })).optional(),
              optionLabels: z.record(z.string(), z.string()).optional(),
              hiddenOptions: z.array(z.string()).optional(),
              defaultValue: z.unknown().optional(),
            }),
          )
          .min(1),
        iterations: z.array(z.string()).optional(),
        iteration: z.string().optional(),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    protectedTool(async (args) =>
      toolResult(
        await apiRequest(apiBase, DEFECT_API + '/rules/save', {
          method: 'POST',
          body: args,
          timeoutMs: 90_000,
        }),
      ),
    ),
  );
  server.registerTool(
    'lantern_defect_rule_delete',
    {
      title: '删除缺陷规则',
      description: '删除指定缺陷规则；若删除当前选中规则，Lantern 会自动切换到剩余第一条。',
      inputSchema: { id: z.string() },
      annotations: { destructiveHint: true },
    },
    protectedTool(async ({ id }) =>
      toolResult(
        await apiRequest(apiBase, DEFECT_API + '/rules/delete', {
          method: 'POST',
          body: { id },
        }),
      ),
    ),
  );
  server.registerTool(
    'lantern_defect_drafts',
    {
      title: '列出缺陷草稿',
      description: '列出当前空间保存的缺陷草稿及提交状态，避免重复生成或遗漏待核验回执。',
      annotations: { readOnlyHint: true },
    },
    protectedTool(async () => toolResult(await apiRequest(apiBase, DEFECT_API + '/drafts'))),
  );
  server.registerTool(
    'lantern_defect_template_select',
    {
      title: '选择缺陷规则',
      description: '按模板 ID 选择缺陷目标和规则。返回该模板最新上下文，切换后重新生成草稿。',
      inputSchema: { id: z.string() },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    protectedTool(async (args) =>
      toolResult(
        await apiRequest(apiBase, DEFECT_API + '/select-template', {
          method: 'POST',
          body: args,
          timeoutMs: 90_000,
        }),
      ),
    ),
  );

  server.registerTool(
    'lantern_defect_context',
    {
      title: '读取缺陷提交上下文',
      description:
        '读取当前空间已配置的缺陷目标、模板、所属迭代、字段、可用选项和字段默认值。发现未配置时请在 Lantern 的缺陷提交页面设置。',
      annotations: { readOnlyHint: true },
    },
    protectedTool(async () =>
      toolResult(await apiRequest(apiBase, DEFECT_API + '/context', { timeoutMs: 90_000 })),
    ),
  );

  server.registerTool(
    'lantern_defect_draft_save',
    {
      title: '保存缺陷草稿',
      description:
        '按上下文字段 ID 保存草稿，返回缺失项、预览和版本。未传入的字段会使用规则默认值；选项和关联值使用实际 ID，图片值使用 image ID 数组。',
      inputSchema: {
        contextRevision: z.string(),
        id: z.string().optional(),
        revision: z.string().optional(),
        values: z.record(
          z.string(),
          z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
        ),
      },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    protectedTool(async (args) =>
      toolResult(
        await apiRequest(apiBase, DEFECT_API + '/draft', {
          method: 'POST',
          body: args,
          timeoutMs: 90_000,
        }),
      ),
    ),
  );

  server.registerTool(
    'lantern_defect_submit',
    {
      title: '提交已确认的缺陷',
      description:
        '用户明确要求最终提交（如「提个缺陷」「提交缺陷」）或确认草稿后调用。纯生成、预览草稿请求不得调用。使用保存草稿返回的 ID 和版本。',
      inputSchema: { id: z.string(), revision: z.string() },
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    protectedTool(async (args) =>
      toolResult(
        await apiRequest(apiBase, DEFECT_API + '/submit', {
          method: 'POST',
          body: args,
          timeoutMs: 110_000,
        }),
      ),
    ),
  );

  server.registerTool(
    'lantern_defect_receipt',
    {
      title: '核验缺陷提交回执',
      description: '按草稿 ID 查询状态。有远端记录 ID 时回读并更新本地回执。',
      inputSchema: { id: z.string() },
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    protectedTool(async ({ id }) =>
      toolResult(await apiRequest(apiBase, DEFECT_API + '/receipt?id=' + encodeURIComponent(id))),
    ),
  );

  return server;
}

/**
 * @param {{ dataRoot: string, url?: string, port?: number }} opts
 */
export async function runLanternMcpServer(opts) {
  const lifecycle = await ensureLanternApi(opts);
  const packageJson = JSON.parse(
    fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  const server = createLanternMcpServer({
    apiBase: lifecycle.apiBase,
    version: String(packageJson.version || '0.0.0'),
  });
  const transport = new StdioServerTransport();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await server.close().catch(() => undefined);
    if (lifecycle.localServer) {
      await new Promise((resolve) => lifecycle.localServer.close(() => resolve(undefined)));
    }
  };
  process.once('SIGINT', () => void close().finally(() => process.exit(0)));
  process.once('SIGTERM', () => void close().finally(() => process.exit(0)));
  process.stdin.once('end', () => void close());
  await server.connect(transport);
  process.stderr.write(
    `Lantern MCP ready (api=${lifecycle.apiBase}, embeddedService=${Boolean(
      lifecycle.localServer,
    )})\n`,
  );
}

export { ensureLanternApi, parseBridgeArgs };

const modulePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(modulePath)) {
  const options = parseBridgeArgs(process.argv.slice(2));
  runLanternMcpServer(options).catch((error) => {
    process.stderr.write(`Lantern MCP error: ${error instanceof Error ? error.message : error}\n`);
    process.exit(1);
  });
}

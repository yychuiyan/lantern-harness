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
        'Lantern 提供测试业务规则、需求文档、需求分析、需求拆解库、测试点、缺陷规则与提交、业务地图和确定性校验。需求分析可列举和批量删除；需求拆解库通过 lantern_requirement_breakdown_* 管理本地 XMind 文件；业务地图系统、目录、功能、流程、登录状态和本地资料可通过对应 lantern_business_* 工具管理，AI 目录/流程识别通过 lantern_business_assistant_* 启动和控制；缺陷规则、草稿、提交和回执通过 lantern_defect_* 管理。业务地图写入必须携带 expectedRevision。需要推理时先读取上下文，生成结构化结果后通过 Lantern 保存工具写回。外接 MCP（如腾讯文档）通过 lantern_mcp_tools 发现、lantern_mcp_call 调用，复用当前空间连接和权限。不要用浏览器点击 Lantern 页面。',
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

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
const SKILL_PROMPT_ROUTES = {
  '需求分析提示词.md': `/${API_PREFIX.slice(1)}reqanalysis/prompt`,
  '原文结构提示词.md': `/${API_PREFIX.slice(1)}reqanalysis/prompt`,
  '用户故事审查提示词.md': `/${API_PREFIX.slice(1)}storyreview/prompt`,
  '测试点生成提示词.md': `/${API_PREFIX.slice(1)}testpoints/prompt`,
};
const REQUIREMENT_WORKFLOW_PLUGINS = ['requirements', 'reqAnalysis', 'storyReview', 'testPoints'];
const ALLOWED_REQUIREMENT_EXT = new Set(['.md', '.txt', '.docx', '.csv', '.xlsx', '.xls']);
const MAX_IMPORT_BYTES = 12 * 1024 * 1024;
const DEFAULT_SOURCE_CHARS = 80_000;

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
  { method = 'GET', body, timeoutMs = 30_000, raw = false } = {},
) {
  const url = `${cleanBase(apiBase)}${route}`;
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
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
        'Lantern 提供测试业务规则、需求文档、需求分析、测试点和确定性校验。需要推理时先读取上下文，生成结构化结果后通过 Lantern 保存工具写回。外接 MCP（如腾讯文档）通过 lantern_mcp_tools 发现、lantern_mcp_call 调用，复用当前空间连接和权限。不要用浏览器点击 Lantern 页面。',
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

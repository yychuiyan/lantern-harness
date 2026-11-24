import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SESSION_VERSION = 1;
const SCAN_VERSION = 2;
const MAX_MESSAGES = 100;
const MAX_EVENTS = 500;
const MODEL_TIMEOUT_MS = 90_000;
const MODEL_HEARTBEAT_MS = 5_000;
const MODEL_MAX_OUTPUT_TOKENS = 12_000;
const FALLBACK_DEFAULT_CHARS = 50_000;
const FALLBACK_MAX_CHARS = 200_000;
const FALLBACK_SOURCE_CHARS = 1_800;
const ACTIVE = new Map();
const CLIENTS = new Map();

const str = (value, max = 4000) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const now = () => new Date().toISOString();

export const assistantDir = (root) =>
  path.join(root, '.lantern', 'local', 'business-map', 'assistant');

function safeId(value) {
  const id = str(value, 80);
  if (!/^[A-Za-z0-9_-]+$/.test(id))
    throw Object.assign(new Error('系统编号无效'), { statusCode: 400 });
  return id;
}

function sessionPath(root, systemId) {
  return path.join(assistantDir(root), `${safeId(systemId)}.json`);
}

function checkpointPath(root, systemId) {
  return path.join(assistantDir(root), `${safeId(systemId)}.checkpoint.json`);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

function emptySession(system) {
  const at = now();
  return {
    version: SESSION_VERSION,
    systemId: system.id,
    phase: 'directory',
    status: 'idle',
    runId: '',
    seq: 0,
    messages: [],
    events: [],
    progress: {
      stage: 'idle',
      label: '等待开始',
      current: 0,
      total: 0,
      percent: 0,
      indeterminate: false,
      startedAt: '',
      elapsedSeconds: 0,
    },
    proposal: null,
    fallback: null,
    directoryApplied: false,
    flowApplied: false,
    createdAt: at,
    updatedAt: at,
  };
}

function normalizeSession(raw, system) {
  const base = emptySession(system);
  if (!raw || typeof raw !== 'object') return base;
  return {
    ...base,
    ...raw,
    systemId: system.id,
    phase: raw.phase === 'flow' ? 'flow' : 'directory',
    status: [
      'idle',
      'running',
      'awaiting_confirmation',
      'stopped',
      'error',
      'interrupted',
    ].includes(raw.status)
      ? raw.status
      : 'idle',
    seq: Math.max(0, Number(raw.seq) || 0),
    messages: Array.isArray(raw.messages) ? raw.messages.slice(-MAX_MESSAGES) : [],
    events: Array.isArray(raw.events) ? raw.events.slice(-MAX_EVENTS) : [],
    progress:
      raw.progress && typeof raw.progress === 'object'
        ? {
            stage: str(raw.progress.stage, 80) || 'idle',
            label: str(raw.progress.label, 300) || '等待开始',
            current: Math.max(0, Number(raw.progress.current) || 0),
            total: Math.max(0, Number(raw.progress.total) || 0),
            percent: Math.min(100, Math.max(0, Number(raw.progress.percent) || 0)),
            indeterminate: raw.progress.indeterminate === true,
            startedAt: str(raw.progress.startedAt, 40),
            elapsedSeconds: Math.max(0, Number(raw.progress.elapsedSeconds) || 0),
          }
        : base.progress,
    fallback:
      raw.fallback && typeof raw.fallback === 'object'
        ? {
            available: raw.fallback.available === true,
            recommendedAction:
              str(raw.fallback.recommendedAction, 80) === 'codex_fallback'
                ? 'client_fallback'
                : str(raw.fallback.recommendedAction, 80),
            reason: str(raw.fallback.reason, 800),
            pageCount: Math.max(0, Number(raw.fallback.pageCount) || 0),
            menuCount: Math.max(0, Number(raw.fallback.menuCount) || 0),
            evidenceCount: Math.max(0, Number(raw.fallback.evidenceCount) || 0),
            sourceChars: Math.max(0, Number(raw.fallback.sourceChars) || 0),
            promptChars: Math.max(0, Number(raw.fallback.promptChars) || 0),
            promptApproxTokens: Math.max(0, Number(raw.fallback.promptApproxTokens) || 0),
            model: str(raw.fallback.model, 200),
            issues: Array.isArray(raw.fallback.issues)
              ? raw.fallback.issues
                  .map((item) => str(item, 500))
                  .filter(Boolean)
                  .slice(0, 20)
              : [],
            updatedAt: str(raw.fallback.updatedAt, 40),
          }
        : null,
    directoryApplied: raw.directoryApplied === true,
    flowApplied: raw.flowApplied === true,
  };
}

function publicSession(session) {
  return {
    ...session,
    messages: session.messages || [],
    events: session.events || [],
  };
}

function appendMessage(session, message) {
  session.messages.push({
    id: crypto.randomUUID(),
    at: now(),
    ...message,
  });
  session.messages = session.messages.slice(-MAX_MESSAGES);
}

function appendEvent(session, event) {
  session.seq += 1;
  const item = {
    id: crypto.randomUUID(),
    seq: session.seq,
    at: now(),
    ...event,
  };
  session.events.push(item);
  session.events = session.events.slice(-MAX_EVENTS);
  session.updatedAt = now();
  for (const res of CLIENTS.get(session.systemId) || []) {
    if (res.destroyed || res.writableEnded) continue;
    res.write(`data: ${JSON.stringify(item)}\n\n`);
  }
  return item;
}

function setProgress(session, stage, label, current, total, extra = {}) {
  const safeTotal = Math.max(0, Number(total) || 0);
  session.progress = {
    stage,
    label,
    current: Math.max(0, Number(current) || 0),
    total: safeTotal,
    percent: safeTotal
      ? Math.min(100, Math.round((Math.max(0, Number(current) || 0) / safeTotal) * 100))
      : 0,
    indeterminate: extra.indeterminate === true || safeTotal === 0,
    startedAt: extra.startedAt || '',
    elapsedSeconds: Math.max(0, Number(extra.elapsedSeconds) || 0),
  };
  appendEvent(session, {
    type: 'progress',
    title: label,
    detail: safeTotal ? `${session.progress.current}/${safeTotal}` : '',
    progress: session.progress,
  });
}

async function modelWithTimeout(model, settings, messages, signal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await model(settings, messages, controller.signal);
  } catch (error) {
    if (timedOut) {
      throw new Error(
        `模型在 ${Math.max(1, Math.round(timeoutMs / 1000))} 秒内没有响应，任务已停止，可检查模型设置后重试`,
      );
    }
    if (signal.aborted) throw signal.reason || error;
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

function compactEvidence(evidence, system) {
  const pageEvidence = evidence.filter((item) => item.type === 'page');
  const lineOwners = new Map();
  const linesBySource = new Map();
  for (const item of pageEvidence) {
    const uniqueLines = new Set(
      String(item.content || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length >= 2),
    );
    linesBySource.set(item.id, uniqueLines);
    for (const line of uniqueLines) lineOwners.set(line, (lineOwners.get(line) || 0) + 1);
  }
  const repeatedThreshold = Math.max(3, Math.ceil(pageEvidence.length * 0.6));
  const pages = pageEvidence
    .slice(0, 120)
    .map((item) => {
      const sourceLines = linesBySource.get(item.id) || new Set();
      const pageSpecific = [...sourceLines].filter(
        (line) => (lineOwners.get(line) || 0) < repeatedThreshold,
      );
      const original = String(item.content || '').trim();
      const content = (pageSpecific.length ? pageSpecific.join('\n') : original).slice(
        0,
        FALLBACK_SOURCE_CHARS,
      );
      return {
        sourceId: item.id,
        title: item.title,
        ref: item.ref,
        content,
      };
    })
    .filter((item) => item.content.trim());
  return {
    system: {
      id: system.id,
      name: system.name,
      description: system.description,
      entryUrl: system.entryUrl,
    },
    pages,
  };
}

function checkpointFallback(root, system) {
  const checkpoint = readJson(checkpointPath(root, system.id), {});
  const catalog = Array.isArray(checkpoint.catalog) ? checkpoint.catalog : [];
  const navigation = Array.isArray(checkpoint.navigation) ? checkpoint.navigation : [];
  const evidence = Array.isArray(checkpoint.evidence) ? checkpoint.evidence : [];
  const issues = (Array.isArray(checkpoint.issues) ? checkpoint.issues : [])
    .map((item) => str(item, 500))
    .filter(Boolean)
    .slice(0, 20);
  const loginExpired = issues.some((item) => item.startsWith('登录态失效'));
  const available = evidence.length > 0 && catalog.length + navigation.length > 0;
  const recommendedAction = available
    ? 'client_fallback'
    : loginExpired
      ? 'retry_login'
      : 'fix_capture';
  return {
    available,
    recommendedAction,
    reason: available
      ? 'Lantern 模型未生成草案，但页面检查点仍可交给调用方模型或编排器继续'
      : loginExpired
        ? '登录态已失效，请重新验证后再采集'
        : '没有取得可分析页面，请检查系统入口、权限或采集配置',
    pageCount: catalog.length,
    menuCount: navigation.length,
    evidenceCount: evidence.length,
    sourceChars: evidence.reduce((total, item) => total + String(item.content || '').length, 0),
    issues,
    updatedAt: str(checkpoint.updatedAt, 40),
  };
}

function boundedNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

async function callModel(settings, messages, signal) {
  const url = new URL(settings.baseURL.replace(/\/+$/, '') + '/chat/completions');
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({
      model: settings.model,
      messages,
      temperature: 0.1,
      max_tokens: boundedNumber(settings.maxOutputTokens, MODEL_MAX_OUTPUT_TOKENS, 1000, 32_000),
      ...(settings.reasoningEffort ? { reasoning_effort: settings.reasoningEffort } : {}),
      response_format: { type: 'json_object' },
      stream: false,
    }),
    signal,
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 300);
    throw new Error(`模型请求失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`);
  }
  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('模型没有返回正文');
  try {
    return {
      value: JSON.parse(content.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')),
      usage: data.usage || {},
    };
  } catch {
    throw new Error('模型结果不是有效 JSON，可在会话中重试');
  }
}

const DIRECTORY_CONTRACT = `你是业务地图功能目录助手。只依据提供的真实菜单、页面目录和证据整理目录树，不得虚构功能。
输出 JSON：
{
  "message": "给用户看的中文说明，简明指出识别范围和待确认项",
  "directories": [{"key":"d1","parentKey":"","name":"一级目录","menuPath":["一级目录"],"entryUrl":""}],
  "functions": [{"name":"功能名","directoryKey":"d1","purpose":"一句话作用","entry":"页面入口","menuPath":["一级目录","功能名"],"evidence":[{"sourceId":"来源ID","quote":"逐字证据"}]}],
  "warnings": ["无法读取或证据不足的说明"]
}
规则：
- context.menuCatalog 是从系统左侧导航直接提取的菜单清单，是目录顺序的唯一依据。
- directories 必须按 menuOrder 顺序完整覆盖 menuCatalog；不得自创大分类、合并菜单或按语义重排。
- menuCatalog 中的每个一级菜单都必须对应一个目录；有子级的菜单必须保留父子路径。重复菜单用不同 key 保留，不得静默丢弃。
- 只有用户明确要求整理或合并目录时，才允许改变菜单清单的名称、层级或顺序。
- 菜单名不能直接当功能。功能必须有页面、文档或用户明确说明作为证据。
- 一个功能只属于一个目录；目录 key 必须唯一，parentKey 必须引用其他目录 key 或为空。
- 不删除已有目录和功能；本阶段只提交新增或更新草案。
- 证据 quote 必须逐字来自对应 sourceId 的 content，找不到证据就不要提交该功能。
- 最多 200 个目录、500 个功能。`;

const FLOW_CONTRACT = `你是业务流程图助手。你只能使用已经应用的功能目录和真实页面证据整理业务流程，不得修改目录或虚构功能。
输出 JSON：
{
  "message": "给用户看的中文说明",
  "flows": [{
    "name": "流程名称",
    "result": "最终业务结果",
    "steps": [{
      "n":1,
      "title":"步骤名",
      "role":"执行角色",
      "system":"参与系统",
      "functionId":"功能ID",
      "input":"输入",
      "output":"输出",
      "next":"2",
      "branch":"",
      "manual":false
    }],
    "evidence":[{"sourceId":"来源ID","quote":"逐字证据"}]
  }],
  "warnings":["待确认说明"]
}
规则：
- 默认覆盖全部已确认功能；用户缩小范围时严格遵守用户范围。
- 每个系统步骤的 functionId 必须来自给定功能列表；纯人工步骤可留空并设置 manual=true。
- 按实际顺序编号；未知下一步或分支明确标记并写入 warnings。
- 证据 quote 必须逐字来自 sourceId 的 content；没有证据的流程不要提交。
- 不删除已有流程。最多 80 条流程、每条 100 步。`;

function normalizeEvidenceRefs(sources, raw) {
  const sourceMap = new Map(sources.map((item) => [item.id, item]));
  const refs = [];
  for (const ref of Array.isArray(raw) ? raw.slice(0, 20) : []) {
    const source = sourceMap.get(str(ref?.sourceId, 80));
    const quote = str(ref?.quote, 2000);
    if (!source || quote.length < 4 || !String(source.content || '').includes(quote)) continue;
    refs.push({
      id: source.id,
      type: 'page',
      title: source.title || source.ref || '页面证据',
      ref: source.ref || '',
      note: quote,
      confidence: 'medium',
    });
  }
  return refs;
}

function normalizeDirectoryProposal(raw, evidence) {
  const directories = [];
  const keyMap = new Map();
  for (const [index, item] of (Array.isArray(raw?.directories) ? raw.directories : [])
    .slice(0, 200)
    .entries()) {
    const name = str(item?.name, 200);
    if (!name) continue;
    let key = str(item?.key, 80) || `d${index + 1}`;
    if (keyMap.has(key)) key = `d${index + 1}_${directories.length}`;
    const directory = {
      key,
      parentKey: str(item?.parentKey, 80),
      name,
      menuPath: Array.isArray(item?.menuPath)
        ? item.menuPath
            .map((part) => str(part, 200))
            .filter(Boolean)
            .slice(0, 20)
        : [name],
      entryUrl: str(item?.entryUrl, 2000),
    };
    keyMap.set(key, directory);
    directories.push(directory);
  }
  for (const directory of directories) {
    if (directory.parentKey && !keyMap.has(directory.parentKey)) directory.parentKey = '';
  }
  const functions = (Array.isArray(raw?.functions) ? raw.functions : [])
    .slice(0, 500)
    .flatMap((item) => {
      const name = str(item?.name, 200);
      if (!name) return [];
      const refs = normalizeEvidenceRefs(evidence, item?.evidence);
      if (!refs.length) return [];
      return [
        {
          name,
          directoryKey: str(item?.directoryKey, 80),
          purpose: str(item?.purpose, 2000),
          entry: str(item?.entry, 1000),
          menuPath: Array.isArray(item?.menuPath)
            ? item.menuPath
                .map((part) => str(part, 200))
                .filter(Boolean)
                .slice(0, 20)
            : [],
          evidence: refs,
        },
      ];
    });
  return {
    kind: 'directory',
    message:
      str(raw?.message, 4000) ||
      `已整理 ${directories.length} 个目录和 ${functions.length} 个功能。`,
    directories,
    functions,
    warnings: (Array.isArray(raw?.warnings) ? raw.warnings : [])
      .map((item) => str(item, 500))
      .filter(Boolean)
      .slice(0, 100),
  };
}

function alignDirectoryProposalToMenu(proposal, menuCatalog) {
  const menuItems = (Array.isArray(menuCatalog) ? menuCatalog : [])
    .map((item, index) => ({
      label: str(item?.label, 200),
      path: (Array.isArray(item?.path) ? item.path : [item?.label])
        .map((part) => str(part, 200))
        .filter(Boolean),
      order: Number.isFinite(Number(item?.order)) ? Number(item.order) : index,
    }))
    .filter((item) => item.label && item.path.length)
    .sort((left, right) => left.order - right.order);
  if (!menuItems.length) return proposal;

  const normalize = (value) =>
    String(value || '')
      .replace(/\s+/g, '')
      .toLowerCase();
  const pathKey = (parts) => parts.map(normalize).join('/');
  const directories = proposal.directories || [];
  const byKey = new Map(directories.map((directory) => [directory.key, directory]));
  const pathByKey = new Map();
  const resolvePath = (directory, seen = new Set()) => {
    if (!directory || seen.has(directory.key)) return [];
    const cached = pathByKey.get(directory.key);
    if (cached) return cached;
    seen.add(directory.key);
    const parent = directory.parentKey ? byKey.get(directory.parentKey) : null;
    const current = [...resolvePath(parent, seen), directory.name];
    pathByKey.set(directory.key, current);
    return current;
  };
  const existingByPath = new Map();
  for (const directory of directories) {
    const key = pathKey(resolvePath(directory));
    if (key && !existingByPath.has(key)) existingByPath.set(key, directory.key);
  }

  let sequence = 0;
  let added = 0;
  for (const item of menuItems) {
    let parentKey = '';
    const prefix = [];
    for (const part of item.path) {
      prefix.push(part);
      const key = pathKey(prefix);
      let directory = directories.find((entry) => entry.key === existingByPath.get(key));
      if (!directory) {
        let directoryKey = `menu_${sequence++}`;
        while (byKey.has(directoryKey)) directoryKey = `menu_${sequence++}`;
        directory = {
          key: directoryKey,
          parentKey,
          name: part,
          menuPath: [...prefix],
          entryUrl: '',
        };
        directories.push(directory);
        byKey.set(directory.key, directory);
        pathByKey.set(directory.key, [...prefix]);
        existingByPath.set(key, directory.key);
        added += 1;
      }
      parentKey = directory.key;
    }
  }

  const rankByPath = new Map();
  for (const item of menuItems) {
    const key = pathKey(item.path);
    rankByPath.set(key, Math.min(rankByPath.get(key) ?? Infinity, item.order));
  }
  const originalIndex = new Map(directories.map((directory, index) => [directory.key, index]));
  directories.sort((left, right) => {
    const leftRank = rankByPath.get(pathKey(resolvePath(left))) ?? 100000;
    const rightRank = rankByPath.get(pathKey(resolvePath(right))) ?? 100000;
    return (
      leftRank - rightRank ||
      (originalIndex.get(left.key) || 0) - (originalIndex.get(right.key) || 0)
    );
  });
  proposal.directories = directories;
  if (added) {
    proposal.warnings = [
      ...(proposal.warnings || []),
      `已按真实系统菜单补充 ${added} 个目录节点，确保菜单顺序和覆盖完整。`,
    ];
  }
  return proposal;
}

function normalizeFlowProposal(raw, evidence, system) {
  const functionNames = new Map(system.functions.map((item) => [item.name, item.id]));
  const functionIds = new Set(system.functions.map((item) => item.id));
  const flows = (Array.isArray(raw?.flows) ? raw.flows : []).slice(0, 80).flatMap((flow) => {
    const name = str(flow?.name, 300);
    if (!name) return [];
    const steps = (Array.isArray(flow?.steps) ? flow.steps : [])
      .slice(0, 100)
      .flatMap((step, index) => {
        const title = str(step?.title, 500);
        if (!title) return [];
        const functionId =
          str(step?.functionId, 64) || functionNames.get(str(step?.functionName, 200)) || '';
        return [
          {
            n: Math.max(1, Number(step?.n) || index + 1),
            title,
            role: str(step?.role, 200),
            system: str(step?.system, 200) || system.name,
            functionId: functionIds.has(functionId) ? functionId : '',
            input: str(step?.input, 1200),
            output: str(step?.output, 1200),
            next: str(step?.next, 100),
            branch: str(step?.branch, 1000),
            branchBroken: Boolean(str(step?.branch, 1000)),
            manual: step?.manual === true || !functionId,
          },
        ];
      });
    if (!steps.length) return [];
    return [
      {
        name,
        result: str(flow?.result, 1000),
        steps,
        evidence: normalizeEvidenceRefs(evidence, flow?.evidence),
      },
    ];
  });
  return {
    kind: 'flow',
    message: str(raw?.message, 4000) || `已整理 ${flows.length} 条业务流程。`,
    flows,
    warnings: (Array.isArray(raw?.warnings) ? raw.warnings : [])
      .map((item) => str(item, 500))
      .filter(Boolean)
      .slice(0, 100),
  };
}

export function createBusinessAssistantService({
  pages,
  applyDirectoryProposal,
  applyFlowProposal,
  invalidateLogin = /** @type {null | ((root: string, system: any) => void | Promise<void>)} */ (
    null
  ),
  model = callModel,
  modelTimeoutMs = MODEL_TIMEOUT_MS,
  modelHeartbeatMs = MODEL_HEARTBEAT_MS,
}) {
  function load(root, system) {
    const session = normalizeSession(readJson(sessionPath(root, system.id), null), system);
    if (session.status === 'running' && !ACTIVE.has(`${root}\0${system.id}`)) {
      session.status = 'interrupted';
      session.runId = '';
      session.fallback = checkpointFallback(root, system);
      appendEvent(session, {
        type: 'status',
        title: '上次会话因服务重启中断',
        detail: '会话历史已保留，可以重新发送该阶段指令继续。',
        status: 'interrupted',
      });
      writeJson(sessionPath(root, system.id), session);
    } else if (['error', 'interrupted'].includes(session.status) && session.fallback === null) {
      session.fallback = checkpointFallback(root, system);
      writeJson(sessionPath(root, system.id), session);
    }
    return session;
  }

  function save(root, session) {
    session.updatedAt = now();
    writeJson(sessionPath(root, session.systemId), session);
  }

  function get(root, system) {
    return publicSession(load(root, system));
  }

  function menu(root, system) {
    const checkpoint = readJson(checkpointPath(root, system.id), {});
    return {
      scanVersion: checkpoint.scanVersion,
      entryUrl: str(checkpoint.entryUrl, 2000),
      updatedAt: str(checkpoint.updatedAt, 40),
      navigation: (Array.isArray(checkpoint.navigation) ? checkpoint.navigation : [])
        .map((item, index) => ({
          label: str(item?.label, 300),
          path: (Array.isArray(item?.path) ? item.path : [])
            .map((part) => str(part, 300))
            .filter(Boolean)
            .slice(0, 20),
          order: Number.isFinite(Number(item?.order)) ? Number(item.order) : index,
        }))
        .filter((item) => item.label),
    };
  }

  function context(root, system, options = {}) {
    const session = load(root, system);
    const checkpoint = readJson(checkpointPath(root, system.id), {});
    const catalog = Array.isArray(checkpoint.catalog) ? checkpoint.catalog : [];
    const navigation = Array.isArray(checkpoint.navigation) ? checkpoint.navigation : [];
    const evidence = Array.isArray(checkpoint.evidence) ? checkpoint.evidence : [];
    const maxChars = boundedNumber(
      options.maxChars,
      FALLBACK_DEFAULT_CHARS,
      4_000,
      FALLBACK_MAX_CHARS,
    );
    const maxCharsPerPage = boundedNumber(
      options.maxCharsPerPage,
      FALLBACK_SOURCE_CHARS,
      200,
      8_000,
    );
    const includeContent = options.includeContent !== false;
    const compacted = compactEvidence(evidence, system).pages;
    let remaining = maxChars;
    let truncated = false;
    const sources = [];
    if (includeContent) {
      for (const source of compacted) {
        if (remaining <= 0) {
          truncated = true;
          break;
        }
        const content = source.content.slice(0, Math.min(maxCharsPerPage, remaining));
        if (!content) continue;
        sources.push({ ...source, content });
        remaining -= content.length;
        if (content.length < source.content.length) truncated = true;
      }
    }
    const fallback = checkpointFallback(root, system);
    return {
      system: {
        id: system.id,
        name: system.name,
        description: system.description,
        entryUrl: system.entryUrl,
      },
      phase: session.phase,
      sessionStatus: session.status,
      fallback: {
        ...fallback,
        canGenerateDirectory: fallback.available,
        canGenerateFlow: fallback.available && system.functions.length > 0,
      },
      checkpoint: {
        scanVersion: checkpoint.scanVersion,
        entryUrl: checkpoint.entryUrl,
        updatedAt: checkpoint.updatedAt,
        issues: Array.isArray(checkpoint.issues) ? checkpoint.issues.slice(0, 100) : [],
        catalog,
        navigation,
      },
      current: {
        directories: system.directories,
        functions: system.functions.map((item) => ({
          id: item.id,
          code: item.code,
          name: item.name,
          directoryId: item.directoryId,
          purpose: item.purpose,
          status: item.status,
          confidence: item.confidence,
        })),
        flows: system.flows.map((item) => ({
          id: item.id,
          code: item.code,
          name: item.name,
          status: item.status,
          stepCount: item.steps.length,
        })),
      },
      sources,
      limits: { maxChars, maxCharsPerPage, truncated },
    };
  }

  async function executeTurn(root, systemId, settings, runId, phase, instruction, refresh) {
    const key = `${root}\0${systemId}`;
    const active = ACTIVE.get(key);
    if (!active || active.runId !== runId) return;
    const system = active.system;
    const session = active.session;
    const signal = active.controller.signal;
    try {
      appendEvent(session, {
        type: 'status',
        title: phase === 'directory' ? '开始识别功能目录' : '开始识别业务流程',
        status: 'running',
      });
      const checkpoint = readJson(checkpointPath(root, systemId), {});
      let catalog = checkpoint.catalog || [];
      let navigation = checkpoint.navigation || [];
      let evidence = checkpoint.evidence || [];
      const needsScan =
        refresh ||
        checkpoint.scanVersion !== SCAN_VERSION ||
        !catalog.length ||
        !evidence.length ||
        checkpoint.phase !== phase ||
        checkpoint.entryUrl !== system.entryUrl;
      if (needsScan) {
        appendEvent(session, {
          type: 'tool',
          title: 'scan_navigation',
          detail: '读取系统菜单和页面，仅执行只读请求',
          status: 'running',
        });
        setProgress(session, 'scan', '正在读取系统菜单和页面', 0, 0);
        const browser = await pages(
          root,
          system,
          {
            sources: { page: { enabled: true } },
            scope: { mode: 'system', targets: [] },
            entryUrl: system.entryUrl,
            pageUrls: [],
            sourceDir: system.sourceDir,
            maxPages: Number(active.maxPages) || 120,
            maxDepth: 6,
            maxChars: 2000000,
          },
          {
            signal,
            onProgress: (_stage, label) => {
              const current = session.events.filter(
                (event) => event.type === 'page' && event.runId === runId,
              ).length;
              appendEvent(session, {
                type: 'page',
                runId,
                title: '已读取页面',
                detail: label,
              });
              setProgress(session, 'scan', '正在读取系统页面', current + 1, 0);
              save(root, session);
            },
          },
        );
        catalog = browser.pages || [];
        navigation = browser.navigation || [];
        evidence = browser.evidence || [];
        const checkpointNext = {
          scanVersion: SCAN_VERSION,
          phase,
          entryUrl: system.entryUrl,
          catalog,
          navigation,
          evidence,
          issues: browser.issues || [],
          updatedAt: now(),
        };
        writeJson(checkpointPath(root, systemId), checkpointNext);
        for (const issue of browser.issues || [])
          appendEvent(session, { type: 'warning', title: '采集说明', detail: issue });
        if (
          typeof invalidateLogin === 'function' &&
          (browser.issues || []).some((issue) => String(issue).startsWith('登录态失效'))
        ) {
          try {
            await invalidateLogin(root, system);
          } catch {
            // 状态清理失败不应覆盖真正的采集错误。
          }
        }
        if (!navigation.length) {
          appendEvent(session, {
            type: 'warning',
            title: '未提取到结构化菜单',
            detail: '页面中没有识别到稳定的侧边导航树，目录草案可能只覆盖当前可见页面。',
          });
        }
        appendEvent(session, {
          type: 'tool',
          title: 'scan_navigation',
          detail: `发现 ${catalog.length} 个页面、${navigation.length} 个菜单，读取 ${evidence.length} 份页面正文`,
          status: 'done',
        });
      } else {
        appendEvent(session, {
          type: 'tool',
          title: 'read_pages',
          detail: `复用 ${catalog.length} 个页面目录、${navigation.length} 个菜单，不重复扫描`,
          status: 'done',
        });
      }
      if (!evidence.length) throw new Error('没有取得可分析页面，请检查登录态、入口或页面权限');

      const modelStartedAt = Date.now();
      const startedAt = new Date(modelStartedAt).toISOString();
      setProgress(session, 'model', '模型正在生成识别草案', 0, 0, {
        indeterminate: true,
        startedAt,
      });
      const context = {
        instruction,
        phase,
        currentDirectories: system.directories,
        currentFunctions: system.functions.map((item) => ({
          id: item.id,
          name: item.name,
          directoryId: item.directoryId,
          purpose: item.purpose,
        })),
        menuCatalog: navigation
          .map((item, index) => ({
            label: item.label,
            path: item.path,
            depth: item.depth,
            order: Number.isFinite(Number(item.order)) ? Number(item.order) : index,
          }))
          .sort((left, right) => left.order - right.order),
        pageCatalog: catalog.map((item) => ({
          id: item.id,
          title: item.title,
          url: item.url,
          status: item.status,
          menuPath: item.menuPath,
          menuOrder: item.menuOrder,
          actionable: item.actionable,
          contentLength: item.contentLength,
        })),
        previousProposal: session.proposal,
        sources: compactEvidence(evidence, system),
      };
      const modelMessages = [
        {
          role: 'system',
          content:
            (phase === 'directory' ? DIRECTORY_CONTRACT : FLOW_CONTRACT) +
            `\n当前业务系统：${system.name}\n入口：${system.entryUrl || '未配置'}`,
        },
        {
          role: 'user',
          content: JSON.stringify(context),
        },
      ];
      const promptChars = modelMessages.reduce(
        (total, message) => total + message.content.length,
        0,
      );
      const promptApproxTokens = Math.ceil(promptChars / 3);
      session.fallback = {
        ...checkpointFallback(root, system),
        promptChars,
        promptApproxTokens,
        model: settings.model,
      };
      appendEvent(session, {
        type: 'tool',
        title: phase === 'directory' ? 'submit_directory_proposal' : 'submit_flow_proposal',
        detail: `模型正在生成可审核草案（上下文 ${promptChars} 字符，约 ${promptApproxTokens} tokens）`,
        status: 'running',
      });
      save(root, session);
      const heartbeat = setInterval(() => {
        const elapsedSeconds = Math.max(1, Math.round((Date.now() - modelStartedAt) / 1000));
        setProgress(session, 'model', `模型正在生成识别草案（已等待 ${elapsedSeconds} 秒）`, 0, 0, {
          indeterminate: true,
          startedAt,
          elapsedSeconds,
        });
        save(root, session);
      }, modelHeartbeatMs);
      let response;
      try {
        response = await modelWithTimeout(
          model,
          {
            ...settings,
            maxOutputTokens: MODEL_MAX_OUTPUT_TOKENS,
          },
          modelMessages,
          signal,
          modelTimeoutMs,
        );
      } finally {
        clearInterval(heartbeat);
      }
      const elapsedSeconds = Math.max(1, Math.round((Date.now() - modelStartedAt) / 1000));
      setProgress(session, 'model', '模型已返回，正在校验草案', 1, 1, {
        indeterminate: false,
        startedAt,
        elapsedSeconds,
      });
      const proposal =
        phase === 'directory'
          ? alignDirectoryProposalToMenu(
              normalizeDirectoryProposal(response.value, evidence),
              navigation,
            )
          : normalizeFlowProposal(response.value, evidence, system);
      if (phase === 'directory' && !proposal.functions.length) {
        throw new Error('模型没有生成带有效证据的功能，可交给调用方模型或编排器继续');
      }
      if (phase === 'flow' && !proposal.flows.length) {
        throw new Error('模型没有生成有效业务流程，可交给调用方模型或编排器继续');
      }
      session.proposal = proposal;
      session.fallback = null;
      session.status = 'awaiting_confirmation';
      session.runId = '';
      appendMessage(session, {
        role: 'assistant',
        content: proposal.message,
        proposalKind: proposal.kind,
      });
      appendEvent(session, {
        type: 'proposal',
        title: phase === 'directory' ? '功能目录草案已生成' : '业务流程草案已生成',
        detail:
          phase === 'directory'
            ? `${proposal.directories.length} 个目录、${proposal.functions.length} 个功能`
            : `${proposal.flows.length} 条流程`,
        status: 'awaiting_confirmation',
      });
      appendEvent(session, {
        type: 'tool',
        title: phase === 'directory' ? 'submit_directory_proposal' : 'submit_flow_proposal',
        detail: '草案已通过结构校验',
        status: 'done',
      });
      setProgress(session, 'done', '草案等待确认', 1, 1);
      save(root, session);
    } catch (error) {
      const aborted = signal.aborted;
      session.status = aborted ? 'stopped' : 'error';
      session.runId = '';
      const fallback = checkpointFallback(root, system);
      session.fallback = {
        ...fallback,
        promptChars: Math.max(0, Number(session.fallback?.promptChars) || 0),
        promptApproxTokens: Math.max(0, Number(session.fallback?.promptApproxTokens) || 0),
        model: str(session.fallback?.model || settings.model, 200),
      };
      const fallbackHint = fallback.available
        ? '；页面检查点已保留，可调用业务地图上下文交给 MCP 客户端继续'
        : fallback.recommendedAction === 'retry_login'
          ? '；请先重新验证登录态'
          : '；请修复系统入口、权限或采集配置后重试';
      appendEvent(session, {
        type: 'error',
        title: aborted ? '识别已停止' : '识别失败',
        detail: aborted
          ? '可重新发送该阶段指令。'
          : `${String(error?.message || error).slice(0, 680)}${fallbackHint}`,
        status: session.status,
      });
      save(root, session);
    } finally {
      ACTIVE.delete(key);
    }
  }

  function start(root, system, raw, settings) {
    const key = `${root}\0${system.id}`;
    if (ACTIVE.has(key))
      throw Object.assign(new Error('当前系统已有 AI 回合在运行'), { statusCode: 409 });
    const phase = raw.phase === 'flow' ? 'flow' : 'directory';
    const instruction = str(raw.message, 12000);
    if (!instruction) throw Object.assign(new Error('请输入识别要求'), { statusCode: 400 });
    if (!settings?.baseURL || !settings?.apiKey || !settings?.model)
      throw Object.assign(new Error('请先在模型设置中配置可用模型'), { statusCode: 400 });
    const session = load(root, system);
    if (phase === 'flow' && !session.directoryApplied && !system.functions.length)
      throw Object.assign(new Error('请先识别并应用功能目录，再识别业务流程'), { statusCode: 400 });
    const runId = crypto.randomUUID();
    const controller = new AbortController();
    session.phase = phase;
    session.status = 'running';
    session.runId = runId;
    session.proposal = null;
    session.fallback = null;
    session.progress = { stage: 'queued', label: '准备识别', current: 0, total: 0, percent: 0 };
    appendMessage(session, { role: 'user', content: instruction, phase });
    appendEvent(session, {
      type: 'status',
      title: 'AI 回合已启动',
      detail: phase === 'directory' ? '识别功能目录' : '识别业务流程',
      status: 'running',
    });
    save(root, session);
    ACTIVE.set(key, {
      runId,
      controller,
      session,
      system,
      maxPages: raw.maxPages,
    });
    void executeTurn(
      root,
      system.id,
      {
        baseURL: settings.baseURL,
        model: settings.model,
        apiKey: settings.apiKey,
        reasoningEffort: settings.reasoningEffort,
      },
      runId,
      phase,
      instruction,
      raw.refresh === true,
    );
    return publicSession(session);
  }

  function stop(root, system) {
    const active = ACTIVE.get(`${root}\0${system.id}`);
    if (!active) return get(root, system);
    active.controller.abort();
    return publicSession(active.session);
  }

  async function apply(root, system, raw) {
    const session = load(root, system);
    if (session.status === 'running')
      throw Object.assign(new Error('请等待当前 AI 回合结束'), { statusCode: 409 });
    if (!session.proposal || session.status !== 'awaiting_confirmation')
      throw Object.assign(new Error('当前没有可应用的 AI 草案'), { statusCode: 400 });
    const kind = session.proposal.kind;
    if (kind === 'flow' && !session.directoryApplied && !system.functions.length)
      throw Object.assign(new Error('请先应用功能目录'), { statusCode: 400 });
    const result =
      kind === 'directory'
        ? applyDirectoryProposal(root, system.id, session.proposal, raw.revision)
        : applyFlowProposal(root, system.id, session.proposal, raw.revision);
    session.status = 'idle';
    session.proposal = null;
    if (kind === 'directory') {
      session.directoryApplied = true;
      session.phase = 'flow';
    } else {
      session.flowApplied = true;
    }
    appendMessage(session, {
      role: 'assistant',
      content:
        kind === 'directory'
          ? `已应用 ${result.applied.directories} 个目录和 ${result.applied.functions} 个功能。可以继续识别业务流程。`
          : `已应用 ${result.applied.flows} 条业务流程。`,
      applied: true,
    });
    appendEvent(session, {
      type: 'status',
      title: kind === 'directory' ? '功能目录已应用' : '业务流程已应用',
      detail:
        kind === 'directory'
          ? `${result.applied.directories} 个目录、${result.applied.functions} 个功能`
          : `${result.applied.flows} 条流程`,
      status: 'completed',
    });
    setProgress(session, 'idle', '等待下一步', 0, 0);
    save(root, session);
    return { session: publicSession(session), store: result.store };
  }

  function reset(root, system) {
    if (ACTIVE.has(`${root}\0${system.id}`))
      throw Object.assign(new Error('请先停止当前 AI 回合'), { statusCode: 409 });
    const session = emptySession(system);
    session.directoryApplied = system.functions.length > 0;
    writeJson(sessionPath(root, system.id), session);
    return publicSession(session);
  }

  function subscribe(root, system, after, res) {
    const session = load(root, system);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    for (const event of session.events.filter((item) => item.seq > Math.max(0, after)))
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    if (session.status !== 'running') {
      res.write(
        `data: ${JSON.stringify({
          seq: session.seq,
          type: 'status',
          status: session.status,
          title: '会话状态',
        })}\n\n`,
      );
      res.end();
      return;
    }
    let clients = CLIENTS.get(system.id);
    if (!clients) {
      clients = new Set();
      CLIENTS.set(system.id, clients);
    }
    clients.add(res);
    const heartbeat = setInterval(() => {
      if (!res.destroyed) res.write(': keep-alive\n\n');
    }, 15000);
    const cleanup = () => {
      clearInterval(heartbeat);
      clients?.delete(res);
    };
    res.on('close', cleanup);
    res.on('error', cleanup);
  }

  function remove(root, systemId) {
    const active = ACTIVE.get(`${root}\0${systemId}`);
    active?.controller.abort();
    ACTIVE.delete(`${root}\0${systemId}`);
    fs.rmSync(sessionPath(root, systemId), { force: true });
    fs.rmSync(checkpointPath(root, systemId), { force: true });
  }

  function close() {
    for (const active of ACTIVE.values()) active.controller.abort();
    ACTIVE.clear();
    for (const clients of CLIENTS.values()) {
      for (const res of clients) res.end();
    }
    CLIENTS.clear();
  }

  return { get, menu, context, start, stop, apply, reset, subscribe, remove, close };
}

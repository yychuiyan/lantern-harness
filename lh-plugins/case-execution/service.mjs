import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getUserConfigDir } from '../../cli/user-config.mjs';
import { resolveModelForSpace } from '../lh-config.mjs';
import { readPluginPrompt } from '../plugin-prompts.mjs';
import {
  callExplorer,
  hasExplorer,
  startExplorer,
  stopExplorer,
} from '../uiauto-explorer/sessions.mjs';
import { CASE_EXECUTION_PROMPT_FILE } from '../case-execution-prompt.mjs';
import { EXECUTION_STATUSES, applyCaseExecutionResult, loadCaseDocument } from './files.mjs';

const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const MODEL_TIMEOUT_MS = 90_000;
const MODEL_HEARTBEAT_MS = 5_000;
const MAX_TOOL_ROUNDS = 60;
const AI_RESULT_STATUSES = ['通过', '不通过', '阻塞', '跳过'];
const ACTIVE = new Map();
const AUTH_ACTIVE = new Map();
const CLIENTS = new Map();

const str = (value, max = 4000) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const now = () => new Date().toISOString();

export const caseExecutionRoot = (root) => path.join(root, '.lantern', 'local', 'case-execution');

const runsDir = (root) => path.join(caseExecutionRoot(root), 'runs');
const runPath = (root, runId) => path.join(runsDir(root), `${runId}.json`);

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

function safeId(value) {
  const id = str(value, 80);
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw Object.assign(new Error('执行编号无效'), { statusCode: 400 });
  }
  return id;
}

function targetUrl(value) {
  let url;
  try {
    url = new URL(str(value, 2000));
  } catch {
    throw Object.assign(new Error('请填写有效的 HTTP / HTTPS 测试地址'), { statusCode: 400 });
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw Object.assign(new Error('测试地址必须是有效的 HTTP / HTTPS 地址'), {
      statusCode: 400,
    });
  }
  return url.href;
}

function authRoot() {
  return path.join(getUserConfigDir(), 'case-execution', 'auth');
}

function authKey(root, url) {
  const space = crypto.createHash('sha256').update(path.resolve(root)).digest('hex');
  const origin = crypto.createHash('sha256').update(new URL(url).origin).digest('hex');
  return path.join(authRoot(), space, `${origin}.json`);
}

function savedAuthPath(root, url) {
  const file = authKey(root, url);
  return fs.existsSync(file) ? file : '';
}

function normalizeResult(raw) {
  const status = AI_RESULT_STATUSES.includes(str(raw?.status, 20)) ? str(raw?.status, 20) : '阻塞';
  return {
    status,
    actualResult: str(raw?.actualResult ?? raw?.actual_result, 30000),
    rationale: str(raw?.rationale, 12000),
    unverified: Array.isArray(raw?.unverified)
      ? raw.unverified
          .map((item) => str(item, 1000))
          .filter(Boolean)
          .slice(0, 100)
      : [],
    blocker: str(raw?.blocker, 4000),
    stepResults: Array.isArray(raw?.stepResults)
      ? raw.stepResults
          .slice(0, 100)
          .map((item) => ({
            expected: str(item?.expected, 4000),
            actual: str(item?.actual, 4000),
            passed: item?.passed === true,
            evidence: str(item?.evidence, 2000),
          }))
          .filter((item) => item.expected || item.actual || item.evidence)
      : [],
  };
}

function emptyRun({ casePath, rowIndex, caseData, fileHash, target, authPath }) {
  const at = now();
  return {
    version: 1,
    id: crypto.randomUUID(),
    casePath,
    rowIndex,
    case: caseData,
    fileHash,
    target: {
      url: target,
      authPath: authPath || '',
    },
    status: 'idle',
    runId: '',
    seq: 0,
    events: [],
    progress: {
      label: '等待执行',
      elapsedSeconds: 0,
      toolCount: 0,
    },
    result: null,
    confirmed: null,
    error: '',
    createdAt: at,
    updatedAt: at,
  };
}

function publicRun(run) {
  return {
    ...run,
    target: { ...run.target, authPath: run.target.authPath ? '[local]' : '' },
  };
}

function appendEvent(run, event, root) {
  run.seq += 1;
  const item = {
    id: crypto.randomUUID(),
    seq: run.seq,
    at: now(),
    ...event,
  };
  run.events.push(item);
  run.events = run.events.slice(-800);
  run.updatedAt = now();
  for (const res of CLIENTS.get(`${root}\0${run.id}`) || []) {
    if (res.destroyed || res.writableEnded) continue;
    res.write(`data: ${JSON.stringify(item)}\n\n`);
  }
  return item;
}

function saveRun(root, run) {
  run.updatedAt = now();
  writeJson(runPath(root, run.id), run);
}

function loadRun(root, runId) {
  const run = readJson(runPath(root, safeId(runId)), null);
  if (!run) throw Object.assign(new Error('执行记录不存在'), { statusCode: 404 });
  if (run.status === 'running' && !ACTIVE.has(`${root}\0${run.id}`)) {
    run.status = 'interrupted';
    run.error = '服务重启导致执行中断，请重新执行或手动记录结果';
    appendEvent(run, { type: 'error', title: '执行中断', detail: run.error }, root);
    saveRun(root, run);
  }
  return run;
}

function listRuns(root, casePath = '') {
  if (!fs.existsSync(runsDir(root))) return [];
  return fs
    .readdirSync(runsDir(root))
    .filter((name) => name.endsWith('.json'))
    .map((name) => readJson(path.join(runsDir(root), name), null))
    .filter(Boolean)
    .filter((run) => !casePath || run.casePath === casePath)
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
    .slice(0, 200)
    .map(publicRun);
}

function shotsDir(root, runId) {
  return path.join(caseExecutionRoot(root), 'shots', runId);
}

function clip(value, max = 12000) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}\n...（已截断）` : text;
}

const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'case_browser_open',
      description: '打开当前测试目标地址。第一次执行必须先调用。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '默认使用任务目标；可传相对路径' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'case_browser_snapshot',
      description: '读取当前页面可交互元素快照，ref 只在本页有效。',
      parameters: {
        type: 'object',
        properties: {
          depth: { type: 'number' },
          targetRef: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'case_browser_click',
      description: '点击页面元素，成功后自动返回新快照。',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string' },
          note: { type: 'string' },
        },
        required: ['ref'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'case_browser_fill',
      description: '清空并填写输入框。',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string' },
          text: { type: 'string' },
          note: { type: 'string' },
        },
        required: ['ref', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'case_browser_select',
      description: '选择下拉选项。',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string' },
          value: { type: 'string' },
          note: { type: 'string' },
        },
        required: ['ref', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'case_browser_press',
      description: '按键盘按键。',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          ref: { type: 'string' },
        },
        required: ['key'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'case_browser_hover',
      description: '悬停到页面元素。',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string' },
          note: { type: 'string' },
        },
        required: ['ref'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'case_browser_wait',
      description: '等待页面出现指定文案或等待指定毫秒。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          ms: { type: 'number' },
          timeout: { type: 'number' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'case_browser_screenshot',
      description: '保存当前页面截图作为执行证据。',
      parameters: {
        type: 'object',
        properties: { label: { type: 'string' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'case_browser_console',
      description: '读取当前页面控制台错误、警告和 pageerror。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'case_browser_network',
      description: '读取最近失败的网络请求。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish_case_execution',
      description: '提交本条用例的最终执行结论。完成所有可执行步骤后必须调用。',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: AI_RESULT_STATUSES },
          actualResult: { type: 'string' },
          rationale: { type: 'string' },
          unverified: { type: 'array', items: { type: 'string' } },
          blocker: { type: 'string' },
          stepResults: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                expected: { type: 'string' },
                actual: { type: 'string' },
                passed: { type: 'boolean' },
                evidence: { type: 'string' },
              },
            },
          },
        },
        required: ['status', 'actualResult', 'rationale'],
      },
    },
  },
];

function modelMessages(skill, run) {
  return [
    {
      role: 'system',
      content: `${skill}

当前任务只执行一条测试用例。目标地址：${run.target.url}
你可以使用提供的浏览器工具。每次操作前先读取快照，元素 ref 在页面变化后会失效。
只有真正观察到预期结果才能判定通过。最终必须调用 finish_case_execution。
安全边界：只操作当前目标站点；遇到验证码、登录墙、系统原生弹窗、文件选择器、支付、短信验证码或不可逆高风险动作时标记阻塞。`,
    },
    {
      role: 'user',
      content: JSON.stringify({
        case: run.case,
        targetUrl: run.target.url,
        requiredExecutionColumns: {
          status: true,
          actualResult: true,
        },
      }),
    },
  ];
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
      tools: TOOL_DEFS,
      tool_choice: 'auto',
      temperature: 0.1,
      stream: false,
    }),
    signal,
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 400);
    throw new Error(`模型请求失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`);
  }
  const data = await response.json();
  return {
    usage: data.usage || {},
    message: data.choices?.[0]?.message || {},
  };
}

async function executeTool(root, run, name, args) {
  if (name === 'case_browser_open') {
    const result = await callExplorer(run.id, 'open', {
      url: str(args.url, 2000) || run.target.url,
      settle: 450,
    });
    return {
      url: result.url,
      title: result.title,
      count: result.count,
      snapshot: clip(result.snapshot),
    };
  }
  if (name === 'case_browser_snapshot') {
    const result = await callExplorer(run.id, 'snapshot', {
      depth: Number(args.depth) || 7,
      targetRef: str(args.targetRef, 40),
    });
    return {
      url: result.url,
      title: result.title,
      count: result.count,
      snapshot: clip(result.snapshot),
    };
  }
  if (
    name === 'case_browser_click' ||
    name === 'case_browser_fill' ||
    name === 'case_browser_select' ||
    name === 'case_browser_hover'
  ) {
    const action = name.replace('case_browser_', '');
    const result = await callExplorer(
      run.id,
      'action',
      {
        action,
        ref: str(args.ref, 40),
        text: str(args.text, 8000),
        value: str(args.value, 8000),
        note: str(args.note, 200),
      },
      90_000,
    );
    return {
      ok: true,
      url: result.url,
      snapshot: clip(result.snapshot, 9000),
    };
  }
  if (name === 'case_browser_press') {
    const result = await callExplorer(run.id, 'action', {
      action: 'press',
      ref: str(args.ref, 40),
      key: str(args.key, 40),
    });
    return { ok: true, url: result.url, snapshot: clip(result.snapshot, 9000) };
  }
  if (name === 'case_browser_wait') {
    const result = await callExplorer(
      run.id,
      'waitFor',
      {
        text: str(args.text, 200),
        ms: Number(args.ms) || 0,
        timeout: Math.min(60_000, Math.max(1000, Number(args.timeout) || 15_000)),
      },
      90_000,
    );
    return { ok: true, url: result.url, snapshot: clip(result.snapshot, 9000) };
  }
  if (name === 'case_browser_screenshot') {
    const result = await callExplorer(run.id, 'screenshot', {
      label: str(args.label, 80) || `step-${run.progress.toolCount}`,
    });
    const url = `/__tb_case_run/runs/${encodeURIComponent(run.id)}/shots/${encodeURIComponent(result.file)}`;
    appendEvent(run, { type: 'screenshot', title: '执行截图', detail: result.file, url }, root);
    return { ok: true, file: result.file, url };
  }
  if (name === 'case_browser_console') {
    const result = await callExplorer(run.id, 'console', {});
    return { count: result.messages?.length || 0, messages: (result.messages || []).slice(-40) };
  }
  if (name === 'case_browser_network') {
    const result = await callExplorer(run.id, 'network', {});
    return { count: result.requests?.length || 0, requests: (result.requests || []).slice(-40) };
  }
  throw new Error(`未知工具：${name}`);
}

async function executeRun(root, run, skill, settings, signal) {
  const active = ACTIVE.get(`${root}\0${run.id}`);
  try {
    run.status = 'running';
    saveRun(root, run);
    appendEvent(run, { type: 'status', title: '开始执行', detail: run.case.title }, root);
    fs.mkdirSync(caseExecutionRoot(root), { recursive: true });
    if (!run.target.authPath || !fs.existsSync(run.target.authPath)) {
      throw new Error('目标登录态不存在，请先填写登录态文件或完成手动登录');
    }
    await startExplorer({
      baseDir: caseExecutionRoot(root),
      project: { dir: PACKAGE_ROOT },
      sessionId: run.id,
      baseURL: run.target.url,
      headed: true,
      storageState: run.target.authPath,
    });
    fs.mkdirSync(shotsDir(root, run.id), { recursive: true });
    const messages = modelMessages(skill, run);
    const startedAt = Date.now();
    let result = null;
    for (let round = 0; round < MAX_TOOL_ROUNDS && !result; round += 1) {
      if (signal.aborted) throw signal.reason || new Error('已停止');
      run.progress.elapsedSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      run.progress.label = `AI 正在执行（第 ${round + 1} 轮）`;
      saveRun(root, run);
      const heartbeat = setInterval(() => {
        run.progress.elapsedSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
        run.progress.label = `AI 正在执行（已等待 ${run.progress.elapsedSeconds} 秒）`;
        appendEvent(
          run,
          {
            type: 'progress',
            title: run.progress.label,
            detail: `${run.progress.toolCount} 次工具调用`,
          },
          root,
        );
        saveRun(root, run);
      }, MODEL_HEARTBEAT_MS);
      let response;
      try {
        response = await callModel(settings, messages, signal);
      } finally {
        clearInterval(heartbeat);
      }
      const message = response.message || {};
      messages.push(message);
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      if (!toolCalls.length) {
        const content = str(message.content, 30000);
        if (content) {
          try {
            const parsed = JSON.parse(
              content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''),
            );
            result = normalizeResult(parsed);
            break;
          } catch {
            messages.push({
              role: 'user',
              content: '请继续执行；完成后必须调用 finish_case_execution，不要只返回普通文本。',
            });
            continue;
          }
        }
        messages.push({
          role: 'user',
          content: '请继续执行，并在完成时调用 finish_case_execution。',
        });
        continue;
      }
      for (const call of toolCalls) {
        if (signal.aborted) throw signal.reason || new Error('已停止');
        const name = str(call?.function?.name, 100);
        let args = {};
        try {
          args = JSON.parse(str(call?.function?.arguments, 20000) || '{}');
        } catch {
          messages.push({
            role: 'tool',
            tool_call_id: str(call?.id, 200),
            content: JSON.stringify({ error: '工具参数不是合法 JSON' }),
          });
          continue;
        }
        if (name === 'finish_case_execution') {
          result = normalizeResult(args);
          messages.push({
            role: 'tool',
            tool_call_id: str(call?.id, 200),
            content: JSON.stringify({ ok: true, accepted: true }),
          });
          break;
        }
        run.progress.toolCount += 1;
        appendEvent(
          run,
          {
            type: 'tool',
            title: name,
            detail: str(args.note, 300) || '执行浏览器操作',
            status: 'running',
          },
          root,
        );
        try {
          const output = await executeTool(root, run, name, args);
          messages.push({
            role: 'tool',
            tool_call_id: str(call?.id, 200),
            content: JSON.stringify(output),
          });
          appendEvent(
            run,
            {
              type: 'tool',
              title: name,
              detail: str(args.note, 300) || '已完成',
              status: 'done',
            },
            root,
          );
        } catch (error) {
          const messageText = error instanceof Error ? error.message : String(error);
          messages.push({
            role: 'tool',
            tool_call_id: str(call?.id, 200),
            content: JSON.stringify({ error: messageText }),
          });
          appendEvent(
            run,
            { type: 'tool', title: name, detail: messageText, status: 'error' },
            root,
          );
        }
      }
    }
    if (!result) {
      result = normalizeResult({
        status: '阻塞',
        actualResult: 'AI 执行达到工具轮次上限，未形成最终结论。',
        rationale: '执行过程未完成全部步骤或未观察到可判定结果。',
        blocker: '达到工具轮次上限',
      });
    }
    if (!run.result && !result.actualResult) {
      result.actualResult = result.blocker || result.rationale || '未完成用例执行';
    }
    run.result = result;
    run.status = 'awaiting_confirmation';
    run.progress.label = '执行完成，等待确认';
    appendEvent(
      run,
      {
        type: 'result',
        title: '执行完成',
        detail: `${result.status} · ${result.actualResult.slice(0, 160)}`,
      },
      root,
    );
    saveRun(root, run);
  } catch (error) {
    const aborted = signal.aborted;
    const message = aborted ? '执行已停止' : error instanceof Error ? error.message : String(error);
    run.status = aborted ? 'stopped' : 'error';
    run.error = message;
    run.result = normalizeResult({
      status: '阻塞',
      actualResult: message,
      rationale: '执行未能完成。',
      blocker: message,
      unverified: ['全部用例步骤'],
    });
    appendEvent(
      run,
      {
        type: 'error',
        title: run.status === 'stopped' ? '执行已停止' : '执行失败',
        detail: message,
      },
      root,
    );
    saveRun(root, run);
  } finally {
    if (hasExplorer(run.id)) stopExplorer(run.id);
    active?.controller?.abort();
    const key = `${root}\0${run.id}`;
    for (const client of CLIENTS.get(key) || []) {
      if (!client.destroyed && !client.writableEnded) client.end();
    }
    CLIENTS.delete(key);
    ACTIVE.delete(`${root}\0${run.id}`);
  }
}

function skillText(root) {
  return (
    readPluginPrompt(CASE_EXECUTION_PROMPT_FILE, root).trim() ||
    '执行当前单条测试用例，真实操作并给出通过、不通过、阻塞或跳过的可核验结论。'
  );
}

export function startRun(root, raw) {
  if (ACTIVE.size) {
    throw Object.assign(new Error('当前空间已有用例正在执行'), { statusCode: 409 });
  }
  const casePath = str(raw.casePath, 1000);
  const rowIndex = Number(raw.rowIndex);
  const url = targetUrl(raw.url || raw.targetUrl);
  const authPath = str(raw.storageStatePath, 2000) || savedAuthPath(root, url) || '';
  if (!authPath) {
    throw Object.assign(new Error('请先填写登录态文件或完成手动登录'), { statusCode: 400 });
  }
  const authAbs = path.resolve(authPath);
  if (!fs.existsSync(authAbs) || !fs.statSync(authAbs).isFile()) {
    throw Object.assign(new Error('登录态文件不存在'), { statusCode: 400 });
  }
  return (async () => {
    const document = await loadCaseDocument(root, casePath);
    if (!document.executable) {
      throw Object.assign(new Error(document.executionIssue), {
        statusCode: 422,
      });
    }
    if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= document.cases.length) {
      throw Object.assign(new Error('用例行不存在'), { statusCode: 404 });
    }
    const caseData = document.cases[rowIndex];
    const run = emptyRun({
      casePath,
      rowIndex,
      caseData,
      fileHash: document.fileHash,
      target: url,
      authPath: authAbs,
    });
    const settings = resolveModelForSpace(root);
    if (!settings.baseURL || !settings.apiKey || !settings.model) {
      throw Object.assign(new Error('请先在模型设置中配置可用模型'), { statusCode: 400 });
    }
    const controller = new AbortController();
    run.status = 'running';
    run.runId = run.id;
    saveRun(root, run);
    ACTIVE.set(`${root}\0${run.id}`, { controller, run });
    void executeRun(root, run, skillText(root), settings, controller.signal);
    return publicRun(run);
  })();
}

export function getRun(root, runId) {
  return publicRun(loadRun(root, runId));
}

export function listExecutionRuns(root, casePath) {
  return listRuns(root, str(casePath, 1000));
}

export function stopRun(root, runId) {
  const run = loadRun(root, runId);
  const active = ACTIVE.get(`${root}\0${run.id}`);
  if (!active) return publicRun(run);
  active.controller.abort(new Error('用户停止执行'));
  if (hasExplorer(run.id)) stopExplorer(run.id);
  run.status = 'stopped';
  run.error = '用户停止执行';
  appendEvent(run, { type: 'status', title: '执行已停止', status: 'stopped' }, root);
  saveRun(root, run);
  return publicRun(run);
}

export async function confirmRun(root, runId, raw) {
  const run = loadRun(root, runId);
  if (run.status === 'running') {
    throw Object.assign(new Error('用例仍在执行，请等待结束或先停止'), { statusCode: 409 });
  }
  const status = str(raw.status, 20);
  const actualResult = str(raw.actualResult, 30000);
  if (!EXECUTION_STATUSES.includes(status)) {
    throw Object.assign(new Error('用例状态无效'), { statusCode: 400 });
  }
  if (!actualResult) {
    throw Object.assign(new Error('实际结果不能为空'), { statusCode: 400 });
  }
  const applied = await applyCaseExecutionResult(root, {
    path: run.casePath,
    expectedFileHash: run.fileHash,
    rowIndex: run.rowIndex,
    status,
    actualResult,
    executor: str(raw.executor, 200) || 'AI + 人工确认',
    executedAt: now().replace('T', ' ').slice(0, 19),
    evidence: run.events
      .filter((event) => event.type === 'screenshot')
      .map((event) => event.url)
      .slice(-8)
      .join('\n'),
    defectNo: str(raw.defectNo, 200),
  });
  run.status = 'confirmed';
  run.confirmed = {
    status,
    actualResult,
    at: now(),
    backup: applied.backup,
    fileHash: applied.fileHash,
  };
  appendEvent(
    run,
    {
      type: 'applied',
      title: '结果已写入用例文件',
      detail: `${status} · ${actualResult.slice(0, 120)}`,
    },
    root,
  );
  saveRun(root, run);
  return { run: publicRun(run), applied };
}

export async function applyManualResult(root, raw) {
  const status = str(raw.status, 20);
  const actualResult = str(raw.actualResult, 30000);
  if (!EXECUTION_STATUSES.includes(status)) {
    throw Object.assign(new Error('用例状态无效'), { statusCode: 400 });
  }
  if (!actualResult) {
    throw Object.assign(new Error('实际结果不能为空'), { statusCode: 400 });
  }
  return applyCaseExecutionResult(root, {
    path: str(raw.casePath, 1000),
    expectedFileHash: str(raw.expectedFileHash, 80),
    rowIndex: Number(raw.rowIndex),
    status,
    actualResult,
    executor: str(raw.executor, 200) || '人工',
    executedAt: now().replace('T', ' ').slice(0, 19),
    evidence: str(raw.evidence, 4000),
    defectNo: str(raw.defectNo, 200),
  });
}

export function subscribeRun(root, runId, after, res) {
  const run = loadRun(root, runId);
  const key = `${root}\0${run.id}`;
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  for (const event of run.events.filter((item) => Number(item.seq) > Number(after || 0))) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  if (run.status !== 'running') {
    res.end();
    return;
  }
  const set = CLIENTS.get(key) || new Set();
  set.add(res);
  CLIENTS.set(key, set);
  reqOnClose(res, () => {
    set.delete(res);
    if (!set.size) CLIENTS.delete(key);
  });
}

function reqOnClose(res, fn) {
  res.once('close', fn);
  res.once('finish', fn);
}

export async function startManualLogin(root, raw) {
  if (AUTH_ACTIVE.size) {
    throw Object.assign(new Error('已有登录窗口正在等待完成'), { statusCode: 409 });
  }
  const url = targetUrl(raw.url);
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  const id = crypto.randomUUID();
  const session = { id, root, url, browser, context, page, status: 'awaiting_login' };
  AUTH_ACTIVE.set(root, session);
  return { ok: true, authId: id, status: session.status, url: page.url() };
}

export async function completeManualLogin(root) {
  const session = AUTH_ACTIVE.get(root);
  if (!session) {
    throw Object.assign(new Error('没有等待完成的登录窗口'), { statusCode: 404 });
  }
  const pageUrl = new URL(session.page.url());
  if (pageUrl.origin !== new URL(session.url).origin) {
    throw Object.assign(new Error('请先完成登录并进入目标业务系统'), { statusCode: 409 });
  }
  const state = await session.context.storageState();
  const file = authKey(root, session.url);
  writeJson(file, state);
  await session.browser.close().catch(() => undefined);
  AUTH_ACTIVE.delete(root);
  return { ok: true, status: 'ready', authPath: file };
}

export async function cancelManualLogin(root) {
  const session = AUTH_ACTIVE.get(root);
  if (!session) return { ok: true, status: 'idle' };
  await session.browser.close().catch(() => undefined);
  AUTH_ACTIVE.delete(root);
  return { ok: true, status: 'cancelled' };
}

export function savedAuthFor(root, raw) {
  const url = targetUrl(raw.url);
  const file = savedAuthPath(root, url);
  return { exists: Boolean(file) };
}

export function shotPath(root, runId, file) {
  const base = path.resolve(shotsDir(root, safeId(runId)));
  const abs = path.resolve(base, path.basename(str(file, 200)));
  if (!abs.startsWith(base + path.sep)) {
    throw Object.assign(new Error('截图路径无效'), { statusCode: 400 });
  }
  return abs;
}

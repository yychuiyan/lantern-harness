/**
 * 需求分析存储（空间级）：`<当前数据空间>/需求分析/需求分析.json`。
 *
 * 一次分析 = 一份文档：来源需求文档的路径 / 指纹、抽出的需求条目、拆出的用户故事、
 * 最近一次体检报告。目录只在真的有数据时创建（第一次保存时），与其它空间插件一致。
 *
 * 编号（US-001）由服务端按 `storySeq` 递增分配，删除后不回收；
 * 需求条目（RO-1）由前端按批次生成，服务端只做去重与合法性校验。
 * 所有枚举与字段白名单都在这里做一次，前端与 AI 工具只提交白名单字段。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { getDataRoot } from '../builtin/session/space-context.mjs';
import { resolveContentRoot } from '../builtin/session/space-layout.mjs';
import { ensurePluginPrompt, isPluginOnInSpace, readPluginPrompt } from './plugin-prompts.mjs';
import {
  REQ_ANALYSIS_PROMPT_FILE,
  REQ_ANALYSIS_PROMPT_TEMPLATE,
  parseReqPromptSections,
} from './req-analysis-prompt.mjs';

const PREFIX = '/__tb_reqanalysis';
const VERSION = 1;

/** 固定数据目录：与导航分组同名时会被改名，需登记到 lh-nav-groups 的 SKIP_DIR_NAMES */
export const REQ_ANALYSIS_DIR_NAME = '需求分析';
export const REQ_ANALYSIS_STORE_FILE = '需求分析.json';

export const REQ_DOC_STATUSES = ['draft', 'decomposed', 'checked', 'accepted'];
export const STORY_PRIORITIES = ['P0', 'P1', 'P2'];
/** 体检缺口类型：规则侧与模型侧共用同一套 */
export const GAP_TYPES = [
  'uncovered-outline',
  'missing-field',
  'missing-scenario',
  'missing-dimension',
  'untestable-acceptance',
  'conflict',
  'over-split',
  'other',
];
export const GAP_SEVERITIES = ['high', 'medium', 'low'];
export const GAP_ORIGINS = ['rule', 'model'];
export const CHECK_STAGES = ['idle', 'outline', 'stories', 'audit', 'done'];

/** 数据文件路径：只算路径，不建目录 */
export function reqAnalysisStorePath(spaceDir) {
  return path.join(path.resolve(spaceDir), REQ_ANALYSIS_DIR_NAME, REQ_ANALYSIS_STORE_FILE);
}

/* ------------------------ 来源需求文档（只读） ------------------------ */

/** 需求文档库目录名：来源文档都从这里读，不写回 */
const REQ_DOCS_DIR_NAME = '需求文档库';

/** 能直接当正文读的纯文本格式 */
export const REQ_SOURCE_TEXT_EXTS = ['.md', '.markdown', '.txt', '.csv'];
/** 需要抽文本的格式（Word / Excel） */
export const REQ_SOURCE_OFFICE_EXTS = ['.docx', '.xlsx', '.xls'];
/** 页面里会列出来、但暂时不能拆解的格式（只给提示） */
export const REQ_SOURCE_UNSUPPORTED_EXTS = ['.doc', '.pdf', '.pptx', '.ppt'];
export const REQ_SOURCE_EXTS = [
  ...REQ_SOURCE_TEXT_EXTS,
  ...REQ_SOURCE_OFFICE_EXTS,
  ...REQ_SOURCE_UNSUPPORTED_EXTS,
];

/** 单份来源文档抽取后的正文字数上限：超长文档按章节切批，没必要把整本塞进来 */
const MAX_SOURCE_CHARS = 600_000;

function sourceExt(rel) {
  return path.extname(String(rel ?? '')).toLowerCase();
}

/** 需求文档库的绝对目录（只算路径，可能还不存在） */
export function reqDocsDir(spaceDir) {
  return resolveContentRoot(spaceDir, REQ_DOCS_DIR_NAME).abs;
}

/**
 * Word（docx）正文抽取：按段落 + 表格拼成纯文本。
 * 标题层级压成 `#` / `##`，方便前端按 `^## ` 切分章节。
 */
async function extractDocx(fileAbs) {
  const { default: mammoth } = await import('mammoth');
  // 传 buffer 而不是路径：数据空间路径常带中文，交给库自己拼路径容易读不到
  const { value } = await mammoth.extractRawText({ buffer: fs.readFileSync(fileAbs) });
  const lines = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line, index, all) => line || all[index - 1]);
  return lines.join('\n').trim();
}

/** Excel 正文抽取：每个工作表一个 `## 工作表名` 章节 + CSV 正文 */
async function extractSheet(fileAbs) {
  const { default: xlsx } = await import('xlsx');
  const book = xlsx.read(fs.readFileSync(fileAbs), { type: 'buffer', cellDates: true });
  const parts = [];
  for (const name of book.SheetNames) {
    const csv = xlsx.utils.sheet_to_csv(book.Sheets[name], { blankrows: false });
    const body = String(csv ?? '').trim();
    if (!body) continue;
    parts.push(`## ${name}\n\n${body}`);
  }
  return parts.join('\n\n').trim();
}

/**
 * 读一份来源需求文档的正文。
 * 只读：不落 .extracted.md、不改需求文档库；返回 `{ content, format }`。
 */
export async function readReqSourceFile(spaceDir, rel) {
  const raw = String(rel ?? '')
    .replace(/\\/g, '/')
    .trim();
  if (!raw || raw.includes('\0') || raw.split('/').includes('..')) {
    throw Object.assign(new Error('非法的来源文档路径'), { statusCode: 400 });
  }
  const root = path.resolve(reqDocsDir(spaceDir));
  const abs = path.resolve(root, raw);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw Object.assign(new Error('来源文档越界'), { statusCode: 403 });
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    throw Object.assign(new Error(`来源文档不存在：${raw}`), { statusCode: 404 });
  }
  const ext = sourceExt(abs);
  if (REQ_SOURCE_UNSUPPORTED_EXTS.includes(ext)) {
    throw Object.assign(
      new Error(`${ext} 暂不支持拆解，请先另存为 Word（.docx）/ Excel（.xlsx）或 Markdown`),
      { statusCode: 415 },
    );
  }
  let content = '';
  try {
    if (REQ_SOURCE_OFFICE_EXTS.includes(ext)) {
      content = ext === '.docx' ? await extractDocx(abs) : await extractSheet(abs);
    } else if (REQ_SOURCE_TEXT_EXTS.includes(ext)) {
      content = fs.readFileSync(abs, 'utf8');
    } else {
      throw Object.assign(new Error(`不支持的来源格式：${ext || '（无扩展名）'}`), {
        statusCode: 415,
      });
    }
  } catch (err) {
    if (err?.statusCode) throw err;
    throw Object.assign(new Error(`读取来源文档失败：${err?.message ?? err}`), { statusCode: 500 });
  }
  const trimmed = String(content ?? '')
    .replace(/\r\n?/g, '\n')
    .trim();
  if (!trimmed) {
    throw Object.assign(new Error('来源文档没有可读文本（可能是扫描件或空文件）'), {
      statusCode: 422,
    });
  }
  return {
    content: trimmed.length > MAX_SOURCE_CHARS ? trimmed.slice(0, MAX_SOURCE_CHARS) : trimmed,
    format: ext.replace(/^\./, ''),
    chars: trimmed.length,
    truncated: trimmed.length > MAX_SOURCE_CHARS,
  };
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      // 需求正文 / 故事集可能不小，但 8MB 足够；超出直接拒绝，避免把内存撑爆
      if (size > 8 * 1024 * 1024) {
        reject(badRequest('提交内容太大（上限 8MB）'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function text(value, max = 2000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function oneOf(value, allowed, fallback) {
  const s = text(value, 40);
  return allowed.includes(s) ? s : fallback;
}

function list(value, max = 30, itemMax = 500) {
  if (!Array.isArray(value)) return [];
  return value
    .map((x) => text(x, itemMax))
    .filter(Boolean)
    .slice(0, max);
}

/* ------------------------------ 故事 ------------------------------ */

function mainFlowSteps(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw.slice(0, 40)) {
    if (!item || typeof item !== 'object') continue;
    const action = text(item.action, 500);
    if (!action) continue;
    out.push({ actor: text(item.actor, 80), action, result: text(item.result, 500) });
  }
  return out;
}

function altFlows(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw.slice(0, 20)) {
    if (!item || typeof item !== 'object') continue;
    const name = text(item.name, 120);
    const steps = list(item.steps, 20, 500);
    if (!name && !steps.length) continue;
    out.push({ name: name || '替代流程', trigger: text(item.trigger, 500), steps });
  }
  return out;
}

function exceptions(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw.slice(0, 30)) {
    if (!item || typeof item !== 'object') continue;
    const scenario = text(item.scenario, 500);
    if (!scenario) continue;
    out.push({ scenario, expected: text(item.expected, 500) });
  }
  return out;
}

function acceptance(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw.slice(0, 30)) {
    if (!item || typeof item !== 'object') continue;
    const given = text(item.given, 500);
    const when = text(item.when, 500);
    const then = text(item.then, 500);
    if (!given && !when && !then) continue;
    out.push({ given, when, then });
  }
  return out;
}

/** 故事白名单；id 不合法或重复时置空，由调用方按 seq 分配 */
function normalizeStory(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = text(raw.title, 200);
  if (!title) return null;
  const id = /^US-\d{1,4}$/.test(String(raw.id ?? '')) ? String(raw.id) : '';
  return {
    id,
    title,
    role: text(raw.role, 120),
    goal: text(raw.goal, 500),
    value: text(raw.value, 500),
    sourceRefs: list(raw.sourceRefs, 20, 40),
    priority: oneOf(raw.priority, STORY_PRIORITIES, 'P1'),
    preconditions: list(raw.preconditions, 20, 500),
    mainFlow: mainFlowSteps(raw.mainFlow),
    altFlows: altFlows(raw.altFlows),
    exceptions: exceptions(raw.exceptions),
    postconditions: list(raw.postconditions, 20, 500),
    acceptance: acceptance(raw.acceptance),
    dimensions: list(raw.dimensions, 12, 40),
  };
}

/* ------------------------------ 需求条目 ------------------------------ */

function normalizeOutlineItem(raw, fallbackId) {
  if (!raw || typeof raw !== 'object') return null;
  const title = text(raw.title, 200);
  const quote = text(raw.quote, 500);
  if (!title && !quote) return null;
  const id = /^[A-Za-z0-9_-]{1,24}$/.test(String(raw.id ?? '')) ? String(raw.id) : fallbackId;
  return { id, title: title || quote.slice(0, 80), quote };
}

/* ------------------------------ 体检报告 ------------------------------ */

function normalizeGap(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = text(raw.title, 200);
  if (!title) return null;
  const type = oneOf(raw.type, GAP_TYPES, 'other');
  const storyId = /^US-\d{1,4}$/.test(String(raw.storyId ?? '')) ? String(raw.storyId) : '';
  return {
    id: /^g_[A-Za-z0-9_-]{3,40}$/.test(String(raw.id ?? '')) ? String(raw.id) : newId('g'),
    storyId,
    type,
    severity: oneOf(raw.severity, GAP_SEVERITIES, 'medium'),
    title,
    detail: text(raw.detail, 1000),
    suggestion: text(raw.suggestion, 1000),
    origin: oneOf(raw.origin, GAP_ORIGINS, 'rule'),
    selected: raw.selected === true,
  };
}

function normalizeCheck(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const gaps = (Array.isArray(raw.gaps) ? raw.gaps : []).map(normalizeGap).filter(Boolean);
  const coverage = raw.coverage && typeof raw.coverage === 'object' ? raw.coverage : {};
  const total = Math.max(0, Number(coverage.total) || 0);
  const covered = Math.min(total, Math.max(0, Number(coverage.covered) || 0));
  return {
    at: text(raw.at, 40) || new Date().toISOString(),
    summary: text(raw.summary, 2000),
    coverage: { total, covered, rate: total ? covered / total : 0 },
    dimensions: (Array.isArray(raw.dimensions) ? raw.dimensions : []).slice(0, 24).map((d) => ({
      key: text(d?.key, 40),
      label: text(d?.label, 60),
      covered: d?.covered === true,
      stories: list(d?.stories, 50, 20),
    })),
    gaps: gaps.slice(0, 200),
  };
}

/* ------------------------------ 文档 ------------------------------ */

function normalizeProgress(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const total = Math.max(0, Number(raw.total) || 0);
  return {
    stage: oneOf(raw.stage, CHECK_STAGES, 'idle'),
    done: Math.min(total || 999, Math.max(0, Number(raw.done) || 0)),
    total,
    message: text(raw.message, 500),
    at: text(raw.at, 40) || new Date().toISOString(),
  };
}

function normalizeDoc(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const sourcePath = text(raw.sourcePath, 1000);
  const now = new Date().toISOString();
  const doc = {
    id: text(raw.id, 64) || newId('ra'),
    title: text(raw.title, 200) || sourcePath.split('/').pop() || '未命名分析',
    sourcePath,
    sourceTitle: text(raw.sourceTitle, 200),
    sourceHash: text(raw.sourceHash, 64),
    status: oneOf(raw.status, REQ_DOC_STATUSES, 'draft'),
    outline: [],
    stories: [],
    check: normalizeCheck(raw.check),
    progress: normalizeProgress(raw.progress),
    storySeq: Math.max(0, Number(raw.storySeq) || 0),
    createdAt: text(raw.createdAt, 40) || now,
    updatedAt: text(raw.updatedAt, 40) || now,
  };

  const seenOutline = new Set();
  const outline = (Array.isArray(raw.outline) ? raw.outline : [])
    .map((item, i) => normalizeOutlineItem(item, `RO-${i + 1}`))
    .filter(Boolean);
  let outlineSeq = 0;
  for (const item of outline) {
    outlineSeq += 1;
    if (seenOutline.has(item.id)) item.id = `RO-${item.id}-${outlineSeq}`;
    seenOutline.add(item.id);
    doc.outline.push(item);
  }

  const seenStory = new Set();
  for (const item of (Array.isArray(raw.stories) ? raw.stories : []).map(normalizeStory)) {
    if (!item) continue;
    // 空 id / 重复 id 按已有最大编号补一个
    if (!item.id || seenStory.has(item.id)) {
      doc.storySeq += 1;
      item.id = `US-${String(doc.storySeq).padStart(3, '0')}`;
    } else {
      const n = Number(item.id.slice(3));
      doc.storySeq = Math.max(doc.storySeq, n);
    }
    seenStory.add(item.id);
    doc.stories.push(item);
  }
  return doc;
}

function emptyStore() {
  return { version: VERSION, docs: [] };
}

function normalizeStore(raw) {
  const base = emptyStore();
  if (!raw || typeof raw !== 'object') return base;
  base.docs = (Array.isArray(raw.docs) ? raw.docs : []).map(normalizeDoc).filter(Boolean);
  return base;
}

function readStore(root) {
  const fp = reqAnalysisStorePath(root);
  try {
    const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
    if (Array.isArray(raw)) return normalizeStore({ docs: raw });
    return normalizeStore(raw);
  } catch {
    return emptyStore();
  }
}

/** 先写临时文件再 rename：中途失败也不会留下半份 JSON */
function writeStore(root, store) {
  const fp = reqAnalysisStorePath(root);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const tmp = `${fp}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, fp);
}

/** 覆盖故事集：保留仍存在的 id，新故事按 seq 分配；`replace` 时重新从 US-001 开始 */
function applyStories(doc, rawStories, replace = false) {
  const incoming = (Array.isArray(rawStories) ? rawStories : [])
    .map(normalizeStory)
    .filter(Boolean);
  if (replace) {
    doc.storySeq = 0;
  }
  const existing = new Set(doc.stories.map((s) => s.id));
  const used = new Set();
  const out = [];
  for (const story of incoming) {
    let id = story.id && existing.has(story.id) && !used.has(story.id) ? story.id : '';
    if (!id) {
      doc.storySeq += 1;
      id = `US-${String(doc.storySeq).padStart(3, '0')}`;
    }
    used.add(id);
    out.push({ ...story, id });
  }
  doc.stories = out;
}

function applyOutline(doc, rawOutline) {
  doc.outline = (Array.isArray(rawOutline) ? rawOutline : [])
    .map((item, i) => normalizeOutlineItem(item, `RO-${i + 1}`))
    .filter(Boolean)
    .filter((item, i, arr) => arr.findIndex((x) => x.id === item.id) === i);
}

function buildDoc(raw) {
  const now = new Date().toISOString();
  const sourcePath = text(raw.sourcePath, 1000);
  if (!sourcePath) throw badRequest('缺少来源文档路径');
  const doc = {
    id: newId('ra'),
    title:
      text(raw.title, 200) ||
      text(raw.sourceTitle, 200) ||
      sourcePath.split('/').pop() ||
      '未命名分析',
    sourcePath,
    sourceTitle: text(raw.sourceTitle, 200),
    sourceHash: text(raw.sourceHash, 64),
    status: 'draft',
    outline: [],
    stories: [],
    check: null,
    progress: null,
    storySeq: 0,
    createdAt: now,
    updatedAt: now,
  };
  applyOutline(doc, raw.outline);
  applyStories(doc, raw.stories, true);
  return doc;
}

function normalizePatch(base, raw) {
  const patch = {};
  if ('title' in raw) patch.title = text(raw.title, 200) || base.title;
  if ('sourcePath' in raw) patch.sourcePath = text(raw.sourcePath, 1000);
  if ('sourceTitle' in raw) patch.sourceTitle = text(raw.sourceTitle, 200);
  if ('sourceHash' in raw) patch.sourceHash = text(raw.sourceHash, 64);
  if ('status' in raw) patch.status = oneOf(raw.status, REQ_DOC_STATUSES, base.status);
  if ('summary' in raw) patch.summary = text(raw.summary, 2000);
  if ('progress' in raw) patch.progress = normalizeProgress(raw.progress);
  if ('check' in raw) patch.check = normalizeCheck(raw.check);
  return patch;
}

/**
 * @returns {import('vite').Plugin}
 */
export function lhReqAnalysisPlugin() {
  return {
    name: 'lh-req-analysis',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const parsed = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (!parsed.pathname.startsWith(PREFIX)) return next();
        // 数据根惰性读取：切换数据空间后无需重启
        const root = getDataRoot();
        const tail = parsed.pathname.slice(PREFIX.length) || '/';

        try {
          const method = req.method || 'GET';

          if (method === 'GET' && parsed.searchParams.get('health') === '1') {
            // 探测不算读写：只算路径，不建目录
            return sendJson(res, 200, {
              ok: true,
              files: { store: reqAnalysisStorePath(root) },
              version: VERSION,
            });
          }

          if (method === 'GET' && tail === '/prompt') {
            // 插件还开着但文件被删（外部删除 / 换空间）时自动补种子：
            // 「重新打开插件会重新生成」不能只靠开关那一下，这里也兜一层
            if (isPluginOnInSpace('reqAnalysis', root)) {
              ensurePluginPrompt(REQ_ANALYSIS_PROMPT_FILE, REQ_ANALYSIS_PROMPT_TEMPLATE, root);
            }
            const content = readPluginPrompt(REQ_ANALYSIS_PROMPT_FILE, root);
            const sections = parseReqPromptSections(content);
            return sendJson(res, 200, {
              ok: true,
              file: REQ_ANALYSIS_PROMPT_FILE,
              exists: Boolean(content.trim()),
              ...sections,
            });
          }

          if (method === 'POST' && tail === '/prompt/sync') {
            const body = JSON.parse((await readBody(req)) || '{}');
            if (body.enabled !== true) {
              // 关闭只停用：文件保留，再打开仍引用同一份
              return sendJson(res, 200, {
                ok: true,
                enabled: false,
                removed: false,
                exists: Boolean(readPluginPrompt(REQ_ANALYSIS_PROMPT_FILE, root).trim()),
                file: REQ_ANALYSIS_PROMPT_FILE,
              });
            }
            const out = ensurePluginPrompt(
              REQ_ANALYSIS_PROMPT_FILE,
              REQ_ANALYSIS_PROMPT_TEMPLATE,
              root,
            );
            return sendJson(res, 200, { ok: true, enabled: true, ...out });
          }

          if (method === 'GET' && tail === '/list') {
            const store = readStore(root);
            return sendJson(res, 200, { ok: true, docs: store.docs });
          }

          /** 来源需求库清单：只给路径 + 格式，正文按需再取（word / excel 不预抽） */
          if (method === 'GET' && tail === '/sources') {
            const dir = reqDocsDir(root);
            const files = [];
            const walk = (absDir, relDir) => {
              let entries = [];
              try {
                entries = fs.readdirSync(absDir, { withFileTypes: true });
              } catch {
                return;
              }
              for (const entry of entries) {
                if (entry.name.startsWith('.')) continue;
                const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
                const abs = path.join(absDir, entry.name);
                if (entry.isDirectory()) {
                  walk(abs, rel);
                  continue;
                }
                if (!entry.isFile()) continue;
                const ext = sourceExt(entry.name);
                if (!REQ_SOURCE_EXTS.includes(ext)) continue;
                files.push({
                  path: rel,
                  name: entry.name,
                  format: ext.replace(/^\./, ''),
                  supported: !REQ_SOURCE_UNSUPPORTED_EXTS.includes(ext),
                });
              }
            };
            walk(dir, '');
            files.sort((a, b) => a.path.localeCompare(b.path, 'zh'));
            return sendJson(res, 200, { ok: true, files });
          }

          /** 读一份来源文档正文（md / txt / csv 直读，docx / xlsx 抽文本） */
          if (method === 'GET' && tail === '/source') {
            const rel = text(parsed.searchParams.get('path'), 400);
            if (!rel) return sendJson(res, 400, { ok: false, error: '缺少来源文档路径' });
            const out = await readReqSourceFile(root, rel);
            return sendJson(res, 200, { ok: true, path: rel, ...out });
          }

          if (method === 'POST' && tail === '/create') {
            const body = JSON.parse((await readBody(req)) || '{}');
            const store = readStore(root);
            const doc = buildDoc(body);
            store.docs.push(doc);
            writeStore(root, store);
            return sendJson(res, 200, { ok: true, doc });
          }

          if (method === 'PUT' && (tail === '/' || tail === '')) {
            const body = JSON.parse((await readBody(req)) || '{}');
            const id = text(body.id, 64);
            if (!id) return sendJson(res, 400, { ok: false, error: '缺少文档 id' });
            const store = readStore(root);
            const idx = store.docs.findIndex((x) => x.id === id);
            if (idx < 0) return sendJson(res, 404, { ok: false, error: '分析文档不存在' });
            const base = store.docs[idx];
            const next = { ...base, ...normalizePatch(base, body) };
            if ('outline' in body) applyOutline(next, body.outline);
            if ('stories' in body) applyStories(next, body.stories, body.replaceStories === true);
            next.updatedAt = new Date().toISOString();
            store.docs[idx] = next;
            writeStore(root, store);
            return sendJson(res, 200, { ok: true, doc: next });
          }

          if (method === 'POST' && tail === '/delete') {
            const body = JSON.parse((await readBody(req)) || '{}');
            const ids = (Array.isArray(body.ids) ? body.ids : [body.id])
              .map((x) => text(x, 64))
              .filter(Boolean);
            if (!ids.length) return sendJson(res, 400, { ok: false, error: '缺少文档 id' });
            const store = readStore(root);
            const before = store.docs.length;
            store.docs = store.docs.filter((x) => !ids.includes(x.id));
            writeStore(root, store);
            return sendJson(res, 200, { ok: true, removed: before - store.docs.length });
          }

          return sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
        } catch (err) {
          const status = Number(err?.statusCode) || 500;
          return sendJson(res, status, { ok: false, error: String(err?.message ?? err) });
        }
      });
    },
  };
}

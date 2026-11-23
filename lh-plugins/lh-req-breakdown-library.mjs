/**
 * 需求拆解库：保存需求拆解生成的本地 XMind 文件及元数据。
 *
 * 文件：`<当前数据空间>/需求拆解库/*.xmind`
 * 元数据：`<当前数据空间>/.lantern/local/requirement-breakdowns.json`
 *
 * 不保存原文结构/XMind 快照；文件本身就是唯一内容源，用户可在本机 XMind
 * 客户端直接编辑保存。列表每次读取都会重新检查文件存在性、大小和 mtime。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { getDataRoot } from '../builtin/session/space-context.mjs';
import { resolveContentRoot, spaceLocalFile } from '../builtin/session/space-layout.mjs';
import { isPluginOnInSpace } from './plugin-prompts.mjs';
import { analysisRevision } from './req-analysis-revision.mjs';
import { openLocalPath, trashLocalPath } from './lh-project-docs.mjs';

const PREFIX = '/__tb_req_breakdowns';
const VERSION = 2;
const MAX_XMIND_BYTES = 25 * 1024 * 1024;
const APP_VERSION = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

export const REQ_BREAKDOWN_DIR_NAME = '需求拆解库';
export const REQ_BREAKDOWN_STORE_FILE = '需求拆解库.json';
export const REQ_BREAKDOWN_XMIND_DIR = 'XMind';
export const REQ_BREAKDOWN_LOCAL_STORE_FILE = 'requirement-breakdowns.json';

const text = (value, max = 2000) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
const fileDigest = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

export function requirementBreakdownLibraryRoot(spaceDir) {
  return resolveContentRoot(spaceDir, REQ_BREAKDOWN_DIR_NAME).abs;
}

export function requirementBreakdownStorePath(spaceDir) {
  return spaceLocalFile(spaceDir, REQ_BREAKDOWN_LOCAL_STORE_FILE);
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
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function emptyStore() {
  return { version: VERSION, revision: 0, seq: 0, entries: [] };
}

function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const entryId = text(raw.id, 80);
  const title = text(raw.title, 300);
  const fileName = path.basename(text(raw.fileName, 300));
  const relativePath = text(raw.relativePath, 2000).replaceAll('\\', '/');
  if (!entryId || !title || !fileName || !relativePath) return null;
  return {
    id: entryId,
    title,
    project: text(raw.project, 200) || '未分类',
    iteration: text(raw.iteration, 100) || '未标注',
    sourcePath: text(raw.sourcePath, 1000),
    sourceTitle: text(raw.sourceTitle, 300),
    sourceHash: text(raw.sourceHash, 64),
    fileHash: text(raw.fileHash, 64),
    analysisId: text(raw.analysisId, 80),
    analysisRevision: text(raw.analysisRevision, 64),
    sourceExportAt: text(raw.sourceExportAt, 80),
    kind: raw.kind === 'uploaded' ? 'uploaded' : 'generated',
    fileName,
    relativePath,
    size: Math.max(0, Number(raw.size) || 0),
    mtime: text(raw.mtime, 80),
    note: text(raw.note, 4000),
    createdAt: text(raw.createdAt, 80) || now(),
    updatedAt: text(raw.updatedAt, 80) || now(),
  };
}

function normalizeStore(raw) {
  const base = emptyStore();
  if (!raw || typeof raw !== 'object') return base;
  base.revision = Math.max(0, Number(raw.revision) || 0);
  base.seq = Math.max(0, Number(raw.seq) || 0);
  base.entries = (Array.isArray(raw.entries) ? raw.entries : [])
    .map(normalizeEntry)
    .filter(Boolean);
  return base;
}

function legacyStorePath(root) {
  return path.join(requirementBreakdownLibraryRoot(root), REQ_BREAKDOWN_STORE_FILE);
}

function cleanupLegacyLibraryDirs(root) {
  const removeEmpty = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    let empty = true;
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        if (entry.name === '.DS_Store') {
          fs.rmSync(path.join(dir, entry.name), { force: true });
          continue;
        }
        empty = false;
        continue;
      }
      const child = path.join(dir, entry.name);
      if (!removeEmpty(child)) empty = false;
    }
    if (!empty) return false;
    try {
      fs.rmdirSync(dir);
      return true;
    } catch {
      return false;
    }
  };
  removeEmpty(path.join(requirementBreakdownLibraryRoot(root), REQ_BREAKDOWN_XMIND_DIR));
}

function flattenLibraryFiles(root, store) {
  const libraryRoot = requirementBreakdownLibraryRoot(root);
  fs.mkdirSync(libraryRoot, { recursive: true });
  const used = new Set();
  let changed = false;
  for (const entry of store.entries) {
    const preferred = path.basename(entry.fileName || entry.title || '未命名需求.xmind');
    let fileName = preferred;
    const source = absoluteEntryFile(root, entry);
    const exact = path.join(libraryRoot, preferred);
    if (used.has(fileName) || (fs.existsSync(exact) && exact !== source)) {
      fileName = uniqueFileName(libraryRoot, preferred, false);
    }
    while (used.has(fileName)) fileName = uniqueFileName(libraryRoot, preferred, false);
    used.add(fileName);
    const target = path.join(libraryRoot, fileName);
    if (fs.existsSync(source) && source !== target) {
      fs.renameSync(source, target);
      changed = true;
    }
    const nextRelative = path.relative(libraryRoot, target).replaceAll('\\', '/');
    if (entry.fileName !== fileName) {
      entry.fileName = fileName;
      changed = true;
    }
    if (entry.relativePath !== nextRelative) {
      entry.relativePath = nextRelative;
      changed = true;
    }
    if (fs.existsSync(target)) {
      const stat = fs.statSync(target);
      if (entry.size !== stat.size || entry.mtime !== stat.mtime.toISOString()) {
        entry.size = stat.size;
        entry.mtime = stat.mtime.toISOString();
        changed = true;
      }
      const fileHash = fileDigest(fs.readFileSync(target));
      if (entry.fileHash !== fileHash) {
        entry.fileHash = fileHash;
        changed = true;
      }
    }
  }
  return changed;
}

function reconcileExternalXMindFiles(root, store) {
  const libraryRoot = requirementBreakdownLibraryRoot(root);
  fs.mkdirSync(libraryRoot, { recursive: true });
  const available = new Map();
  for (const name of fs.readdirSync(libraryRoot)) {
    if (!/\.xmind$/i.test(name) || name.startsWith('.')) continue;
    const abs = path.join(libraryRoot, name);
    try {
      const stat = fs.statSync(abs);
      if (stat.isFile()) available.set(abs, { abs, name, stat });
    } catch {
      // 单个文件消失时继续处理其它文件
    }
  }
  let changed = false;
  let revisionChanged = false;
  const tracked = new Set();
  for (const entry of store.entries) {
    const abs = absoluteEntryFile(root, entry);
    if (available.has(abs)) {
      tracked.add(abs);
      const file = available.get(abs);
      if (file.stat.size !== entry.size || file.stat.mtime.toISOString() !== entry.mtime) {
        entry.size = file.stat.size;
        entry.mtime = file.stat.mtime.toISOString();
        changed = true;
      }
      const fileHash = fileDigest(fs.readFileSync(abs));
      if (entry.fileHash !== fileHash) {
        entry.fileHash = fileHash;
        changed = true;
      }
    }
  }

  for (const entry of store.entries) {
    const current = absoluteEntryFile(root, entry);
    if (fs.existsSync(current)) continue;
    const expectedTime = Date.parse(entry.mtime);
    let matchedAbs = '';
    for (const [abs, file] of available) {
      if (tracked.has(abs)) continue;
      const sameHash = entry.fileHash && fileDigest(fs.readFileSync(abs)) === entry.fileHash;
      const sameStat =
        !entry.fileHash &&
        file.stat.size === entry.size &&
        Number.isFinite(expectedTime) &&
        Math.abs(file.stat.mtimeMs - expectedTime) < 1000;
      if (!sameHash && !sameStat) continue;
      matchedAbs = abs;
      break;
    }
    if (!matchedAbs) continue;
    const file = available.get(matchedAbs);
    tracked.add(matchedAbs);
    entry.title = requirementBreakdownTitle(file.name);
    entry.fileName = file.name;
    entry.relativePath = path.relative(libraryRoot, matchedAbs).replaceAll('\\', '/');
    entry.size = file.stat.size;
    entry.mtime = file.stat.mtime.toISOString();
    entry.fileHash = fileDigest(fs.readFileSync(matchedAbs));
    entry.updatedAt = now();
    changed = true;
    revisionChanged = true;
  }

  for (const [abs, file] of available) {
    if (tracked.has(abs)) continue;
    const buffer = fs.readFileSync(abs);
    const title = requirementBreakdownTitle(file.name);
    const createdAt = new Date(
      file.stat.birthtimeMs > 0 ? file.stat.birthtimeMs : file.stat.ctimeMs,
    ).toISOString();
    const entry = normalizeEntry({
      id: id('rbl'),
      title,
      project: '手动上传',
      iteration: requirementBreakdownIteration(file.name),
      sourcePath: '',
      sourceTitle: file.name,
      sourceHash: '',
      fileHash: fileDigest(buffer),
      analysisId: '',
      analysisRevision: '',
      sourceExportAt: '',
      kind: 'uploaded',
      fileName: file.name,
      relativePath: path.relative(libraryRoot, abs).replaceAll('\\', '/'),
      size: file.stat.size,
      mtime: file.stat.mtime.toISOString(),
      note: '',
      createdAt,
      updatedAt: now(),
    });
    if (!entry) continue;
    store.entries.push(entry);
    store.seq += 1;
    changed = true;
    revisionChanged = true;
  }
  if (revisionChanged) touch(store);
  return changed;
}

function readStore(root) {
  const localFile = requirementBreakdownStorePath(root);
  const legacyFile = legacyStorePath(root);
  const local = readJson(localFile, null);
  const legacyExists = fs.existsSync(legacyFile);
  const legacy = local || !legacyExists ? null : readJson(legacyFile, null);
  const store = normalizeStore(local || legacy);
  if (!local && legacy) {
    const backup = `${localFile}.v1.bak`;
    try {
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      if (!fs.existsSync(backup)) fs.copyFileSync(legacyFile, backup);
    } catch {
      // 备份失败不阻断迁移；正式文件仍按无损重命名处理
    }
  }
  const flattened = flattenLibraryFiles(root, store);
  const reconciled = reconcileExternalXMindFiles(root, store);
  if (!local || flattened || reconciled) writeJson(localFile, store);
  if (legacyExists) fs.rmSync(legacyFile, { force: true });
  cleanupLegacyLibraryDirs(root);
  return store;
}

function writeStore(root, store) {
  writeJson(requirementBreakdownStorePath(root), store);
  return store;
}

function touch(store) {
  store.revision += 1;
}

function safeSegment(value, fallback) {
  const clean = String(value || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return clean || fallback;
}

function sourceFileName(doc) {
  const raw = text(doc?.sourceTitle, 300) || text(doc?.sourcePath, 1000);
  return path.basename(raw || text(doc?.title, 300) || '未命名需求');
}

function sourceStem(fileName) {
  return path.basename(fileName, path.extname(fileName));
}

function breakdownPrefix(fileName) {
  const stem = sourceStem(fileName).trim();
  return (stem.split('_')[0] || stem || '未命名需求').trim();
}

export function requirementBreakdownTitle(fileName) {
  return `${safeSegment(breakdownPrefix(fileName), '未命名需求')}_需求拆解.xmind`;
}

export function requirementBreakdownProject(sourcePath) {
  const posix = String(sourcePath || '').replaceAll('\\', '/');
  const parent = path.posix.dirname(posix);
  if (!parent || parent === '.') return '未分类';
  return path.posix.basename(parent) || '未分类';
}

export function requirementBreakdownIteration(fileName) {
  const match = sourceStem(fileName).match(/(?:^|[^A-Za-z0-9])V(\d+(?:\.\d+)*)/i);
  return match ? `V${match[1]}` : '未标注';
}

function stamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function uniqueFileName(dir, logicalTitle, allowExact = true, currentAbs = '') {
  const ext = '.xmind';
  const base = path.basename(logicalTitle, ext);
  const exact = path.join(dir, logicalTitle);
  if (allowExact && (exact === currentAbs || !fs.existsSync(exact))) {
    return path.basename(exact);
  }
  let candidate = path.join(dir, `${base}_${stamp()}${ext}`);
  let index = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base}_${stamp()}-${index}${ext}`);
    index += 1;
  }
  return path.basename(candidate);
}

function collisionSuffix(absPath) {
  return path.basename(absPath, '.xmind').match(/_(\d{8}-\d{6}(?:-\d+)?)$/)?.[1] || '';
}

function renameFileName(dir, logicalTitle, currentAbs) {
  const exact = path.join(dir, logicalTitle);
  if (exact === currentAbs || !fs.existsSync(exact)) return path.basename(exact);
  const suffix = collisionSuffix(currentAbs);
  if (suffix) {
    const base = path.basename(logicalTitle, '.xmind');
    let candidate = path.join(dir, `${base}_${suffix}.xmind`);
    let index = 2;
    while (candidate !== currentAbs && fs.existsSync(candidate)) {
      candidate = path.join(dir, `${base}_${suffix}-${index}.xmind`);
      index += 1;
    }
    return path.basename(candidate);
  }
  return uniqueFileName(dir, logicalTitle, false, currentAbs);
}

const TAIL_FIELD_SRC =
  '输入参数|输出参数|正常流程|扩展流程|补充说明|前置条件|优先级|提出人|附件|备注';
const TAIL_FIELD_CUT = new RegExp(
  `(?:^|[|｜。；;\\s])(?:无\\s*)?(?:${TAIL_FIELD_SRC})(?=\\s*[|｜]|\\s*$)`,
);
const REQ_ID_RE = /(?:需求编号|编号)\s*[|｜:：]\s*([A-Za-z]{1,8}(?:-\d+)+)/;
const STEP_MARK_RE = /(?:^|[\s。；;|｜])(\d{1,2}(?:[、．]|\.(?=\s)))/g;
const XMIND_LOGIC_RIGHT = 'org.xmind.ui.logic.right';
const XMIND_SHAPE_ROUNDED = 'org.xmind.topicShape.roundedRect';
const XMIND_LINE_ELBOW = 'org.xmind.branchConnection.elbow';
const XMIND_LINE = '#94a3b8';
const XMIND_BORDER = '#d0d5dd';
const XMIND_INK = '#1c3d5a';

function xmindTopicId(prefix, key) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const digest = (h >>> 0).toString(36);
  const clean = key.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24);
  return clean ? `${prefix}-${clean}-${digest}` : `${prefix}-${digest}`;
}

function topicStyle(fill, color) {
  return {
    id: xmindTopicId('st', `${fill}-${color}`),
    properties: {
      'shape-class': XMIND_SHAPE_ROUNDED,
      'line-class': XMIND_LINE_ELBOW,
      'line-color': XMIND_LINE,
      'line-width': '1',
      'svg:fill': fill,
      'fo:color': color,
      'border-line-color': XMIND_BORDER,
      'border-line-width': '1',
    },
  };
}

const STYLE_ROOT = topicStyle('#1c3d5a', '#ffffff');
const STYLE_GROUP = topicStyle('#4176e6', '#ffffff');
const STYLE_TOPIC = topicStyle('#ffffff', XMIND_INK);

function logicTheme() {
  const level = (fill, color) => ({
    properties: {
      'shape-class': XMIND_SHAPE_ROUNDED,
      'line-class': XMIND_LINE_ELBOW,
      'line-color': XMIND_LINE,
      'line-width': '1',
      'svg:fill': fill,
      'fo:color': color,
      'border-line-color': XMIND_BORDER,
      'border-line-width': '1',
    },
  });
  return {
    centralTopic: level('#1c3d5a', '#ffffff'),
    mainTopic: level('#4176e6', '#ffffff'),
    subTopic: {
      properties: {
        'line-class': XMIND_LINE_ELBOW,
        'svg:fill': '#ffffff',
        'fo:color': XMIND_INK,
        'line-color': XMIND_LINE,
        'line-width': '1',
      },
    },
    map: { properties: { 'svg:fill': '#ffffff', 'line-color': XMIND_LINE } },
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripReqIdPreamble(value, idValue) {
  if (!idValue) return value.trim();
  const re = new RegExp(
    `(?:需求编号|编号)\\s*[|｜:：]\\s*${escapeRegExp(idValue)}(?:\\s*功能名称\\s*[|｜][\\s\\S]*?功能描述\\s*[|｜]\\s*)?`,
  );
  return value
    .replace(re, '')
    .replace(/^[\s|｜:：]+/, '')
    .trim();
}

function stripTailFields(value) {
  const match = TAIL_FIELD_CUT.exec(value);
  if (!match || match.index == null) return value.trim();
  let cut = match.index;
  const sentence = match[0].match(/^[。；;]/);
  if (sentence) cut += sentence[0].length;
  return value
    .slice(0, cut)
    .replace(/[\s|｜]+$/, '')
    .trim();
}

function sourceExportPieces(body) {
  const source = String(body || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!source) return { id: '', parts: [] };
  const idValue = REQ_ID_RE.exec(source)?.[1] || '';
  const marks = [];
  for (const match of source.matchAll(STEP_MARK_RE)) {
    const marker = match[1];
    if (!marker || match.index == null) continue;
    marks.push(match.index + match[0].length - marker.length);
  }
  const parts = [];
  const push = (raw) => {
    const cleaned = stripTailFields(stripReqIdPreamble(raw, idValue));
    if (cleaned) parts.push(cleaned);
  };
  if (marks.length) {
    push(source.slice(0, marks[0]));
    marks.forEach((start, index) => push(source.slice(start, marks[index + 1] ?? source.length)));
  } else {
    push(idValue ? stripReqIdPreamble(source, idValue) : source);
  }
  return { id: idValue, parts };
}

function bodyTopics(prefix, parts) {
  return parts.map((part, index) => ({
    id: xmindTopicId('src', `${prefix}-${index + 1}`),
    title: part,
  }));
}

function titleTopic(title, body, key) {
  const titleText = String(title || '')
    .replace(/\s+/g, ' ')
    .trim();
  const { id: reqId, parts } = sourceExportPieces(body);
  const bodies = bodyTopics(
    `body-${key}`,
    parts.filter((part) => part !== titleText && part !== reqId),
  );
  const children = reqId
    ? [
        {
          id: xmindTopicId('src', `code-${key}`),
          title: reqId,
          structureClass: bodies.length ? XMIND_LOGIC_RIGHT : undefined,
          style: STYLE_TOPIC,
          ...(bodies.length ? { children: { attached: bodies } } : {}),
        },
      ]
    : bodies;
  return {
    id: xmindTopicId('src', `title-${key}`),
    title: titleText || body || '未命名需求',
    structureClass: children.length ? XMIND_LOGIC_RIGHT : undefined,
    style: STYLE_TOPIC,
    ...(children.length ? { children: { attached: children } } : {}),
  };
}

function buildXMindContent(sourceTitle, groups) {
  const categories = (Array.isArray(groups) ? groups : []).map((group, groupIndex) => {
    const attached = (Array.isArray(group.items) ? group.items : []).map((item, itemIndex) =>
      titleTopic(
        text(item.title, 200),
        text(item.body, 4000),
        `${groupIndex + 1}-${itemIndex + 1}`,
      ),
    );
    return {
      id: xmindTopicId('src', `cat-${groupIndex + 1}`),
      title: text(group.category, 200) || '未分大类',
      style: STYLE_GROUP,
      structureClass: attached.length ? XMIND_LOGIC_RIGHT : undefined,
      ...(attached.length ? { children: { attached } } : {}),
    };
  });
  return [
    {
      id: 'sheet-1',
      class: 'sheet',
      title: sourceTitle,
      theme: logicTheme(),
      rootTopic: {
        id: 'root-topic',
        title: sourceTitle,
        structureClass: XMIND_LOGIC_RIGHT,
        style: STYLE_ROOT,
        children: { attached: categories },
      },
    },
  ];
}

async function packXMind(sourceTitle, groups) {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  zip.file('content.json', JSON.stringify(buildXMindContent(sourceTitle, groups)));
  zip.file(
    'metadata.json',
    JSON.stringify({
      creator: { name: 'Lantern Harness', version: APP_VERSION },
      activeSheetId: 'sheet-1',
    }),
  );
  zip.file(
    'manifest.json',
    JSON.stringify({ 'file-entries': { 'content.json': {}, 'metadata.json': {} } }),
  );
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function decodeXml(value) {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export async function readRequirementBreakdownXMind(absPath) {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(fs.readFileSync(absPath));
  const content = zip.file('content.json');
  if (content) {
    const sheets = JSON.parse(await content.async('string'));
    const tree = [];
    const lines = [];
    const walk = (topic, depth = 0) => {
      if (!topic || typeof topic !== 'object') return;
      const title = String(topic.title || '').trim();
      if (title) {
        lines.push(`${'  '.repeat(depth)}- ${title}`);
        tree.push({ title, depth });
      }
      const attached = topic.children?.attached;
      if (Array.isArray(attached)) attached.forEach((child) => walk(child, depth + 1));
    };
    for (const sheet of Array.isArray(sheets) ? sheets : []) {
      const root = sheet?.rootTopic || sheet?.topic;
      if (root) walk(root);
    }
    if (lines.length) return { text: lines.join('\n'), tree };
  }
  const legacy = zip.file('content.xml');
  if (legacy) {
    const xml = await legacy.async('string');
    const titles = [...xml.matchAll(/<title[^>]*>([\s\S]*?)<\/title>/gi)]
      .map((match) => decodeXml(match[1]).trim())
      .filter(Boolean);
    return {
      text: titles.map((title) => `- ${title}`).join('\n'),
      tree: titles.map((title) => ({ title, depth: 0 })),
    };
  }
  throw new Error('XMind 文件里没有 content.json/content.xml');
}

function absoluteEntryFile(root, entry) {
  const base = path.resolve(requirementBreakdownLibraryRoot(root));
  const abs = path.resolve(base, entry.relativePath);
  if (abs !== base && !abs.startsWith(base + path.sep)) throw new Error('XMind 文件路径越界');
  return abs;
}

function withFileState(root, entry) {
  const abs = absoluteEntryFile(root, entry);
  try {
    const stat = fs.statSync(abs);
    return {
      ...entry,
      localPath: abs,
      exists: stat.isFile(),
      size: stat.size,
      fileMtime: stat.mtime.toISOString(),
    };
  } catch {
    return { ...entry, localPath: abs, exists: false, size: 0, fileMtime: '' };
  }
}

function findEntry(store, entryId) {
  return store.entries.find((entry) => entry.id === entryId) || null;
}

function requireRevision(store, expectedRevision) {
  const expected = Number(expectedRevision);
  if (!Number.isFinite(expected)) {
    throw Object.assign(new Error('修改需求拆解库必须提供 expectedRevision'), {
      statusCode: 428,
      currentRevision: store.revision,
    });
  }
  if (expected !== store.revision) {
    throw Object.assign(new Error('需求拆解库已被其他页面修改，请刷新后重试'), {
      statusCode: 409,
      currentRevision: store.revision,
    });
  }
}

function addEntry(root, store, data, buffer, allowExact) {
  const dir = requirementBreakdownLibraryRoot(root);
  fs.mkdirSync(dir, { recursive: true });
  const fileName = uniqueFileName(dir, data.title, allowExact);
  const abs = path.join(dir, fileName);
  const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, buffer);
  fs.renameSync(tmp, abs);
  const stat = fs.statSync(abs);
  const createdAt = now();
  const entry = normalizeEntry({
    id: id('rbl'),
    ...data,
    fileName,
    relativePath: path.relative(requirementBreakdownLibraryRoot(root), abs).replaceAll('\\', '/'),
    size: stat.size,
    mtime: stat.mtime.toISOString(),
    createdAt,
    updatedAt: createdAt,
  });
  store.seq += 1;
  store.entries.push(entry);
  touch(store);
  writeStore(root, store);
  return entry;
}

function normalizeGroups(groups) {
  return (Array.isArray(groups) ? groups : [])
    .map((group) => ({
      category: text(group?.category, 200) || '未分大类',
      items: (Array.isArray(group?.items) ? group.items : [])
        .map((item) => ({
          title: text(item?.title, 200),
          body: text(item?.body, 4000),
        }))
        .filter((item) => item.title || item.body),
    }))
    .filter((group) => group.items.length);
}

export async function recordRequirementBreakdown(root, doc) {
  if (!isPluginOnInSpace('reqBreakdowns', root)) return null;
  const groups = normalizeGroups(doc?.sourceExport?.groups);
  if (!groups.length) return null;
  const sourceExportAt = text(doc?.sourceExport?.at, 80) || text(doc?.updatedAt, 80);
  const analysisId = text(doc?.id, 80);
  const store = readStore(root);
  const existing = store.entries.find(
    (entry) =>
      entry.analysisId === analysisId &&
      entry.sourceExportAt === sourceExportAt &&
      entry.kind === 'generated',
  );
  if (existing) return withFileState(root, existing);
  const fileName = sourceFileName(doc);
  const buffer = await packXMind(fileName, groups);
  const sameTitleCount = store.entries.filter(
    (entry) => entry.title === requirementBreakdownTitle(fileName),
  ).length;
  return withFileState(
    root,
    addEntry(
      root,
      store,
      {
        title: requirementBreakdownTitle(fileName),
        project: requirementBreakdownProject(doc?.sourcePath),
        iteration: requirementBreakdownIteration(fileName),
        sourcePath: text(doc?.sourcePath, 1000),
        sourceTitle: fileName,
        sourceHash: text(doc?.sourceHash, 64),
        analysisId,
        analysisRevision: analysisRevision(doc),
        sourceExportAt,
        kind: 'generated',
        note: '',
      },
      buffer,
      sameTitleCount === 0,
    ),
  );
}

function listEntries(root, store) {
  return store.entries
    .map((entry) => withFileState(root, entry))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function reqAnalysisDocs(root) {
  const file = path.join(resolveContentRoot(root, '需求分析').abs, '需求分析.json');
  const raw = readJson(file, { docs: [] });
  return Array.isArray(raw) ? raw : Array.isArray(raw.docs) ? raw.docs : [];
}

function backfillCandidates(root, store) {
  return reqAnalysisDocs(root)
    .filter((doc) => normalizeGroups(doc?.sourceExport?.groups).length)
    .map((doc) => {
      const sourceExportAt = text(doc?.sourceExport?.at, 80) || text(doc?.updatedAt, 80);
      const recorded = store.entries.some(
        (entry) =>
          entry.analysisId === text(doc?.id, 80) &&
          entry.sourceExportAt === sourceExportAt &&
          entry.kind === 'generated',
      );
      return {
        analysisId: text(doc.id, 80),
        title: text(doc.title, 200),
        sourcePath: text(doc.sourcePath, 1000),
        sourceTitle: text(doc.sourceTitle, 300),
        sourceExportAt,
        updatedAt: text(doc.updatedAt, 80),
        recorded,
      };
    });
}

function writeError(res, error) {
  const status = Number(error?.statusCode) || 500;
  return sendJson(res, status, {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    ...(error?.currentRevision !== undefined ? { currentRevision: error.currentRevision } : {}),
  });
}

function sendJson(res, status, value) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(value));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function enabled(root) {
  return isPluginOnInSpace('reqBreakdowns', root);
}

export function lhReqBreakdownLibraryPlugin(dependencies = {}) {
  const openPath = dependencies.openLocalPath || openLocalPath;
  const trashPath = dependencies.trashLocalPath || trashLocalPath;
  return {
    name: 'lh-req-breakdown-library',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const parsed = new URL(req.url || '/', 'http://127.0.0.1');
        if (!parsed.pathname.startsWith(PREFIX)) return next();
        const root = getDataRoot();
        const tail = parsed.pathname.slice(PREFIX.length).replace(/^\/+|\/+$/g, '');
        const parts = tail ? tail.split('/') : [];
        const method = req.method || 'GET';
        try {
          if (method === 'GET' && parsed.searchParams.get('health') === '1') {
            return sendJson(res, 200, {
              ok: true,
              file: requirementBreakdownStorePath(root),
              version: VERSION,
            });
          }
          if (!enabled(root))
            return sendJson(res, 403, { ok: false, error: '请先开启需求拆解库插件' });
          if (method === 'GET' && tail === 'list') {
            const store = readStore(root);
            return sendJson(res, 200, {
              ok: true,
              revision: store.revision,
              entries: listEntries(root, store),
            });
          }
          if (method === 'GET' && tail === 'backfill') {
            const store = readStore(root);
            return sendJson(res, 200, {
              ok: true,
              revision: store.revision,
              candidates: backfillCandidates(root, store),
            });
          }
          if (method === 'GET' && parts[0] === 'entries' && parts[1]) {
            const store = readStore(root);
            const entry = findEntry(store, parts[1]);
            if (!entry) return sendJson(res, 404, { ok: false, error: '拆解条目不存在' });
            const state = withFileState(root, entry);
            let content = null;
            if (parsed.searchParams.get('includeContent') === '1' && state.exists) {
              content = await readRequirementBreakdownXMind(state.localPath);
            }
            return sendJson(res, 200, {
              ok: true,
              revision: store.revision,
              entry: state,
              content,
            });
          }
          if (method === 'POST' && tail === 'import') {
            const body = JSON.parse((await readBody(req)) || '{}');
            const buffer = Buffer.from(String(body.contentBase64 || ''), 'base64');
            if (!buffer.length) return sendJson(res, 400, { ok: false, error: 'XMind 文件为空' });
            if (buffer.length > MAX_XMIND_BYTES)
              return sendJson(res, 413, { ok: false, error: 'XMind 文件超过 25MB' });
            const name = text(body.name, 300) || '未命名.xmind';
            if (!/\.xmind$/i.test(name))
              return sendJson(res, 400, { ok: false, error: '只支持 .xmind 文件' });
            const tmp = path.join(
              requirementBreakdownLibraryRoot(root),
              `.verify-${crypto.randomUUID()}.xmind`,
            );
            fs.mkdirSync(path.dirname(tmp), { recursive: true });
            fs.writeFileSync(tmp, buffer);
            try {
              await readRequirementBreakdownXMind(tmp);
            } catch (error) {
              fs.rmSync(tmp, { force: true });
              return sendJson(res, 400, {
                ok: false,
                error: `XMind 文件无效：${error instanceof Error ? error.message : error}`,
              });
            } finally {
              fs.rmSync(tmp, { force: true });
            }
            const store = readStore(root);
            requireRevision(store, body.expectedRevision);
            const project = text(body.project, 200) || '手动上传';
            const iteration = text(body.iteration, 100) || requirementBreakdownIteration(name);
            const title = requirementBreakdownTitle(name);
            const entry = withFileState(
              root,
              addEntry(
                root,
                store,
                {
                  title,
                  project,
                  iteration,
                  sourcePath: '',
                  sourceTitle: name,
                  sourceHash: '',
                  analysisId: '',
                  analysisRevision: '',
                  sourceExportAt: '',
                  kind: 'uploaded',
                  note: text(body.note, 4000),
                },
                buffer,
                true,
              ),
            );
            return sendJson(res, 200, { ok: true, revision: store.revision, entry });
          }
          if (method === 'POST' && tail === 'backfill') {
            const body = JSON.parse((await readBody(req)) || '{}');
            const store = readStore(root);
            requireRevision(store, body.expectedRevision);
            const ids = new Set(
              (Array.isArray(body.analysisIds) ? body.analysisIds : [])
                .map((item) => text(item, 80))
                .filter(Boolean),
            );
            const docs = reqAnalysisDocs(root).filter((doc) => ids.has(text(doc.id, 80)));
            const created = [];
            const failed = [];
            for (const doc of docs) {
              try {
                const entry = await recordRequirementBreakdown(root, doc);
                if (entry) created.push(entry);
              } catch (error) {
                failed.push({
                  analysisId: text(doc.id, 80),
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            }
            return sendJson(res, 200, {
              ok: true,
              revision: readStore(root).revision,
              created,
              failed,
            });
          }
          if (parts[0] === 'entries' && parts[1] && parts[2] === 'retry' && method === 'POST') {
            const body = JSON.parse((await readBody(req)) || '{}');
            const store = readStore(root);
            requireRevision(store, body.expectedRevision);
            const entry = findEntry(store, parts[1]);
            if (!entry) return sendJson(res, 404, { ok: false, error: '拆解条目不存在' });
            const doc = reqAnalysisDocs(root).find((item) => item.id === entry.analysisId);
            if (!doc) return sendJson(res, 404, { ok: false, error: '原需求分析记录不存在' });
            const groups = normalizeGroups(doc.sourceExport?.groups);
            if (!groups.length)
              return sendJson(res, 400, { ok: false, error: '原需求分析没有可生成的原文结构' });
            const buffer = await packXMind(sourceFileName(doc), groups);
            const abs = absoluteEntryFile(root, entry);
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, buffer);
            const stat = fs.statSync(abs);
            entry.size = stat.size;
            entry.mtime = stat.mtime.toISOString();
            entry.updatedAt = now();
            touch(store);
            writeStore(root, store);
            return sendJson(res, 200, {
              ok: true,
              revision: store.revision,
              entry: withFileState(root, entry),
            });
          }
          if (parts[0] === 'entries' && parts[1] && parts[2] === 'open' && method === 'POST') {
            const store = readStore(root);
            const entry = findEntry(store, parts[1]);
            if (!entry) return sendJson(res, 404, { ok: false, error: '拆解条目不存在' });
            const abs = absoluteEntryFile(root, entry);
            if (!fs.existsSync(abs))
              return sendJson(res, 404, { ok: false, error: 'XMind 文件不存在' });
            await openPath(abs);
            return sendJson(res, 200, { ok: true });
          }
          if (parts[0] === 'entries' && parts[1] && method === 'PUT') {
            const body = JSON.parse((await readBody(req)) || '{}');
            const store = readStore(root);
            requireRevision(store, body.expectedRevision);
            const entry = findEntry(store, parts[1]);
            if (!entry) return sendJson(res, 404, { ok: false, error: '拆解条目不存在' });
            if (typeof body.note === 'string') entry.note = text(body.note, 4000);
            const nextTitle = text(body.title, 300);
            if (nextTitle) {
              const title = requirementBreakdownTitle(nextTitle);
              if (title !== entry.title) {
                const abs = absoluteEntryFile(root, entry);
                const dir = path.dirname(abs);
                const newName = renameFileName(dir, title, abs);
                const nextAbs = path.join(dir, newName);
                if (fs.existsSync(abs)) fs.renameSync(abs, nextAbs);
                entry.fileName = newName;
                entry.relativePath = path
                  .relative(requirementBreakdownLibraryRoot(root), nextAbs)
                  .replaceAll('\\', '/');
              }
              entry.title = title;
            }
            entry.updatedAt = now();
            touch(store);
            writeStore(root, store);
            return sendJson(res, 200, {
              ok: true,
              revision: store.revision,
              entry: withFileState(root, entry),
            });
          }
          if (parts[0] === 'entries' && parts[1] && method === 'DELETE') {
            const body = JSON.parse((await readBody(req)) || '{}');
            const store = readStore(root);
            requireRevision(store, body.expectedRevision);
            const entry = findEntry(store, parts[1]);
            if (!entry) return sendJson(res, 404, { ok: false, error: '拆解条目不存在' });
            const abs = absoluteEntryFile(root, entry);
            if (fs.existsSync(abs)) await trashPath(abs);
            store.entries = store.entries.filter((item) => item.id !== entry.id);
            touch(store);
            writeStore(root, store);
            return sendJson(res, 200, { ok: true, revision: store.revision });
          }
          return sendJson(res, 404, { ok: false, error: '需求拆解库接口不存在' });
        } catch (error) {
          return writeError(res, error);
        }
      });
    },
  };
}

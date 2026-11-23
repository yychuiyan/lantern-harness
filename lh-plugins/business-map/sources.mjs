import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolveContentRoot } from '../../builtin/session/space-layout.mjs';
import {
  businessLoginRequired,
  businessLoginRoot,
  hasLoginChallenge,
  resolveBusinessLoginState,
} from './auth-paths.mjs';

const CODE_EXT = /\.(md|mdx|txt|json|ya?ml|ts|tsx|js|jsx|vue|svelte|java|kt|py|go|cs|sql|xml)$/i;
const DOC_EXT = /\.(md|markdown|txt|csv|docx|xlsx|xls)$/i;
const MATERIAL_TEXT_EXT = /\.(md|markdown|txt|csv|json|xml|html?|ya?ml)$/i;
const MATERIAL_SUPPORTED_EXT =
  /\.(md|markdown|txt|csv|json|xml|html?|ya?ml|doc|docx|xls|xlsx|xmind|pptx)$/i;
export const BUSINESS_MATERIAL_MAX_BYTES = 25 * 1024 * 1024;
const SKIP_DIRS = new Set([
  '.git',
  '.lantern',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  'vendor',
  '__pycache__',
]);
const SECRET =
  /(^|[/.])(?:\.env(?:\..*)?|\.auth|credentials?|secrets?|id_rsa|id_ed25519)(?:[/.]|$)|\.(pem|key|p12|pfx)$|(?:storage[-_]?state|login[-_]?state|package-lock|pnpm-lock|yarn\.lock)/i;
export const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
export function within(root, abs) {
  return abs === root || abs.startsWith(root + path.sep);
}
export function safeFile(root, rel) {
  const base = fs.realpathSync(root);
  const abs = fs.realpathSync(path.resolve(base, rel));
  if (!within(base, abs) || !fs.statSync(abs).isFile()) throw new Error('文件不在选择的来源目录内');
  return abs;
}

function decodeXml(value) {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function safeMaterialName(value) {
  const name = path.basename(String(value || '').trim()).replace(/[\u0000-\u001f]/g, '');
  if (!name || name === '.' || name === '..' || name.startsWith('.'))
    throw new Error('资料文件名无效');
  if (Buffer.byteLength(name) > 240) throw new Error('资料文件名过长');
  return name;
}

export function businessMaterialDir(root, systemId) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(systemId)) throw new Error('业务系统编号无效');
  return path.join(resolveContentRoot(root, '业务地图').abs, '识别资料', systemId);
}

export function businessMaterialCatalog(root, systemId) {
  const dir = businessMaterialDir(root, systemId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const abs = path.join(dir, entry.name);
      const stat = fs.statSync(abs);
      return {
        id: entry.name,
        name: entry.name,
        path: entry.name,
        size: stat.size,
        updatedAt: stat.mtime.toISOString(),
        supported: MATERIAL_SUPPORTED_EXT.test(entry.name),
      };
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function saveBusinessMaterial(root, systemId, fileName, buffer) {
  if (!buffer?.length) throw new Error('空文件');
  if (buffer.length > BUSINESS_MATERIAL_MAX_BYTES)
    throw new Error(`文件超过 ${BUSINESS_MATERIAL_MAX_BYTES / 1024 / 1024} MB`);
  const name = safeMaterialName(fileName);
  const dir = businessMaterialDir(root, systemId);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, name);
  const tmp = `${dest}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, buffer);
  fs.renameSync(tmp, dest);
  return businessMaterialCatalog(root, systemId).find((item) => item.name === name);
}

export function removeBusinessMaterial(root, systemId, fileName) {
  const name = safeMaterialName(fileName);
  fs.rmSync(path.join(businessMaterialDir(root, systemId), name), { force: true });
}

export function walkFiles(root, predicate, limit = 600, exclusions = []) {
  if (!fs.existsSync(root)) return [];
  const base = fs.realpathSync(root);
  const privateDir = businessLoginRoot();
  const privateRoot = fs.existsSync(privateDir)
    ? fs.realpathSync(privateDir)
    : path.resolve(privateDir);
  const stack = [base],
    output = [];
  while (stack.length && output.length < limit) {
    for (const entry of fs
      .readdirSync(stack.pop(), { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(entry.parentPath || entry.path, entry.name);
      const rel = path.relative(base, abs).replaceAll('\\', '/');
      if (
        entry.isSymbolicLink() ||
        within(privateRoot, abs) ||
        SECRET.test(rel) ||
        exclusions.some((item) => rel === item || rel.startsWith(item.replace(/\/$/, '') + '/'))
      )
        continue;
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) stack.push(abs);
      else if (entry.isFile() && predicate.test(entry.name)) output.push({ rel, abs });
      if (output.length >= limit) break;
    }
  }
  return output;
}

export function documentCatalog(root) {
  return ['需求文档库', '知识库管理'].flatMap((library) => {
    const dir = resolveContentRoot(root, library).abs;
    return walkFiles(dir, /\.(md|markdown|txt|csv|docx|xlsx|xls|pdf|doc|pptx?)$/i, 1000).map(
      (file) => ({
        id: `${library}/${file.rel}`,
        library,
        path: file.rel,
        supported: DOC_EXT.test(file.rel),
      }),
    );
  });
}
async function documentText(abs) {
  if (/\.docx$/i.test(abs)) {
    const mammoth = (await import('mammoth')).default;
    return (await mammoth.extractRawText({ buffer: fs.readFileSync(abs) })).value;
  }
  if (/\.xlsx?$/i.test(abs)) {
    const imported = await import('xlsx');
    const xlsx = imported.default || imported;
    const book = xlsx.read(fs.readFileSync(abs), { type: 'buffer' });
    return book.SheetNames.map(
      (name) => `# ${name}\n${xlsx.utils.sheet_to_csv(book.Sheets[name])}`,
    ).join('\n');
  }
  return fs.readFileSync(abs, 'utf8');
}

async function materialText(abs, name) {
  const lower = name.toLowerCase();
  if (lower.endsWith('.xmind')) {
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(fs.readFileSync(abs));
    const content = zip.file('content.json');
    if (content) {
      const sheets = JSON.parse(await content.async('string'));
      const lines = [];
      const walk = (topic, depth = 0) => {
        if (!topic || typeof topic !== 'object') return;
        const title = String(topic.title || '').trim();
        if (title) lines.push(`${'  '.repeat(depth)}- ${title}`);
        const attached = topic.children?.attached;
        if (Array.isArray(attached)) for (const child of attached) walk(child, depth + 1);
      };
      for (const sheet of Array.isArray(sheets) ? sheets : []) {
        const rootTopic = sheet?.rootTopic || sheet?.topic;
        if (rootTopic) walk(rootTopic);
      }
      if (lines.length) return lines.join('\n');
    }
    const legacy = zip.file('content.xml');
    if (legacy) {
      const xml = await legacy.async('string');
      return [...xml.matchAll(/<title[^>]*>([\s\S]*?)<\/title>/gi)]
        .map((match) => decodeXml(match[1]))
        .filter(Boolean)
        .join('\n');
    }
    throw new Error('XMind 文件里没有可读取的 content.json/content.xml');
  }
  if (lower.endsWith('.pptx')) {
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(fs.readFileSync(abs));
    const slides = Object.keys(zip.files)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
      .sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]));
    const output = [];
    for (const [index, name] of slides.entries()) {
      const xml = await zip.file(name).async('string');
      const lines = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/gi)]
        .map((match) => decodeXml(match[1]).trim())
        .filter(Boolean);
      if (lines.length) output.push(`# 第 ${index + 1} 页\n${lines.join('\n')}`);
    }
    if (output.length) return output.join('\n\n');
    throw new Error('PPTX 文件里没有可读取的文本');
  }
  if (/\.doc$/i.test(lower)) {
    const imported = await import('word-extractor');
    const WordExtractor = imported.default || imported;
    const doc = await new WordExtractor().extract(fs.readFileSync(abs));
    return String(doc.getBody?.() || '').trim();
  }
  if (/\.(docx|xlsx?)$/i.test(lower)) return documentText(abs);
  if (MATERIAL_TEXT_EXT.test(lower)) return fs.readFileSync(abs, 'utf8');
  const raw = fs.readFileSync(abs);
  if (raw.includes(0)) throw new Error(`暂不支持解析 ${path.extname(name) || '该文件类型'}`);
  return raw.toString('utf8');
}
export function makeEvidence(type, ref, content, title = ref) {
  return {
    id: `src_${hash(type + ':' + ref + ':' + content).slice(0, 24)}`,
    type,
    ref,
    title,
    content,
    fingerprint: hash(content),
    at: new Date().toISOString(),
  };
}
export async function collectFiles(root, system, config, { signal, onProgress }) {
  const evidence = [],
    issues = [];
  let collectedChars = 0;
  const add = (type, ref, content, title) => {
    const available = Math.max(0, 2000000 - collectedChars);
    if (content.length > available && !issues.some((issue) => issue.includes('200万字符')))
      issues.push('来源正文达到200万字符上限，结果为部分覆盖');
    content = String(content).slice(0, available);
    collectedChars += content.length;
    let line = 1;
    for (let offset = 0; offset < content.length; offset += 12000) {
      const chunk = content.slice(offset, offset + 12000),
        newlines = (chunk.match(/\n/g) || []).length;
      const end = Math.max(line, line + newlines - (chunk.endsWith('\n') ? 1 : 0));
      if (chunk.trim()) evidence.push(makeEvidence(type, `${ref}#L${line}-L${end}`, chunk, title));
      line += newlines;
    }
  };
  if (config.sources.process?.enabled) {
    const content = system.flows.length
      ? JSON.stringify(
          system.flows.map((flow) => ({
            id: flow.id,
            name: flow.name,
            result: flow.result,
            status: flow.status,
            steps: flow.steps.map((step) => ({
              title: step.title,
              role: step.role,
              system: step.system,
              functionId: step.functionId,
              input: step.input,
              output: step.output,
              next: step.next,
              branch: step.branch,
              branchBroken: step.branchBroken,
              manual: step.manual,
            })),
          })),
          null,
          2,
        )
      : '';
    if (content) {
      add('process', 'system://flows', `# 当前业务流程\n${content}`, '当前业务流程');
      onProgress('processes', `${system.flows.length} 条流程`);
    } else issues.push('业务流程来源：当前系统还没有已维护的流程');
  }
  if (config.sources.doc.enabled) {
    const catalog = documentCatalog(root);
    for (const id of config.documents) {
      signal.throwIfAborted();
      const item = catalog.find((item) => item.id === id);
      if (!item || !item.supported) {
        issues.push(`文档不可用或暂不支持：${id}`);
        continue;
      }
      try {
        const abs = safeFile(resolveContentRoot(root, item.library).abs, item.path);
        if (fs.statSync(abs).size > 8 * 1024 * 1024) throw new Error('文件超过 8MB，请拆分后重试');
        const content = await documentText(abs);
        if (content.length > 300000) issues.push(`文档仅读取前 300000 字：${id}`);
        add('doc', id, content.slice(0, 300000), item.path);
        onProgress('documents', id);
      } catch (error) {
        issues.push(`文档 ${id}：${error.message}`);
      }
    }
  }
  if (config.sources.material?.enabled) {
    const catalog = businessMaterialCatalog(root, system.id);
    for (const name of config.materials || []) {
      signal.throwIfAborted();
      if (collectedChars >= 2000000) break;
      const item = catalog.find((entry) => entry.name === name);
      if (!item) {
        issues.push(`本地资料不存在：${name}`);
        continue;
      }
      if (!item.supported) {
        issues.push(`本地资料暂不支持解析：${name}`);
        continue;
      }
      try {
        if (item.size > BUSINESS_MATERIAL_MAX_BYTES)
          throw new Error(`文件超过 ${BUSINESS_MATERIAL_MAX_BYTES / 1024 / 1024} MB`);
        const abs = path.join(businessMaterialDir(root, system.id), item.name);
        const content = await materialText(abs, item.name);
        if (content.length > 300000) issues.push(`本地资料仅读取前 300000 字：${name}`);
        add('material', `本地资料/${item.name}`, content.slice(0, 300000), item.name);
        onProgress('materials', item.name);
      } catch (error) {
        issues.push(`本地资料 ${name}：${error.message}`);
      }
    }
  }
  if (config.sources.code.enabled) {
    const dir = config.sourceDir || system.sourceDir;
    try {
      if (!dir || !fs.statSync(dir).isDirectory()) throw new Error('请配置可读取的源码目录');
      const files = walkFiles(dir, CODE_EXT, 601, config.exclusions);
      if (files.length > 600) issues.push('源码达到 600 文件上限，结果为部分覆盖');
      for (const file of files.slice(0, 600)) {
        await new Promise((resolve) => setImmediate(resolve));
        signal.throwIfAborted();
        if (collectedChars >= 2000000) break;
        try {
          if (fs.statSync(file.abs).size > 256000) {
            issues.push(`跳过大文件：${file.rel}`);
            continue;
          }
          const content = fs.readFileSync(file.abs, 'utf8');
          if (content.includes('\0')) continue;
          add('code', file.rel, content, file.rel);
          onProgress('code', file.rel);
        } catch (error) {
          issues.push(`源码 ${file.rel}：${error.message}`);
        }
      }
    } catch (error) {
      issues.push(`源码来源：${error.message}`);
    }
  }
  return { evidence, issues };
}

export async function collectOnlineDocuments(root, system, config, { signal, onProgress }) {
  const evidence = [],
    issues = [];
  if (!config.sources.onlineDoc?.enabled) return { evidence, issues };
  const urls = (config.onlineDocUrls || [])
    .map((value) => {
      try {
        const url = new URL(value);
        return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
      } catch {
        return '';
      }
    })
    .filter(Boolean);
  if (!urls.length) return { evidence, issues: ['在线文档来源没有有效链接'] };
  let collectedChars = 0;
  const maxChars = config.maxChars ?? 2000000;
  const runtime = loadBrowserRuntime([
    config.runtimeDir,
    config.sourceDir,
    system.sourceDir,
    fileURLToPath(new URL('../..', import.meta.url)),
    process.cwd(),
  ]);
  const browser = await runtime.chromium.launch({ headless: true });
  const stop = () => void browser.close().catch(() => {});
  signal.addEventListener('abort', stop, { once: true });
  try {
    let storageState;
    const loginStateFile = system.id ? resolveBusinessLoginState(root, system) : '';
    if (loginStateFile && fs.existsSync(loginStateFile))
      storageState = JSON.parse(fs.readFileSync(loginStateFile, 'utf8'));
    const context = await browser.newContext({
      storageState,
      serviceWorkers: 'block',
      acceptDownloads: false,
    });
    await context.route('**/*', async (route) => {
      const request = route.request();
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
        if (issues.length < 200)
          issues.push(`在线文档只读拦截：${request.method()} ${new URL(request.url()).pathname}`);
        return route.abort();
      }
      return route.continue();
    });
    await context.addInitScript(() => {
      window.WebSocket = class {
        constructor() {
          throw new Error('业务地图只读采集不开放 WebSocket');
        }
      };
      navigator.sendBeacon = () => false;
    });
    const page = await context.newPage();
    for (const url of urls) {
      signal.throwIfAborted();
      if (collectedChars >= maxChars) break;
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(900);
        if (await hasLoginChallenge(page)) {
          issues.push(`在线文档需要登录或验证：${url}`);
          continue;
        }
        const title = await page.title().catch(() => '');
        const frameTexts = [];
        for (const frame of page.frames()) {
          const text = await frame
            .evaluate(() => document.body?.innerText?.slice(0, 120000) || '')
            .catch(() => '');
          if (text.trim()) frameTexts.push(text);
        }
        const content = [...new Set(frameTexts)].join('\n\n');
        const remaining = Math.max(0, maxChars - collectedChars);
        if (content.length > remaining) issues.push('在线文档来源达到正文预算，结果为部分覆盖');
        const sliced = content.slice(0, Math.min(remaining, 300000));
        if (sliced.trim()) {
          evidence.push(makeEvidence('online_doc', page.url(), sliced, title || url));
          collectedChars += sliced.length;
        } else issues.push(`在线文档没有可读取正文：${url}`);
        onProgress('onlineDocs', title || url);
      } catch (error) {
        if (signal.aborted) throw error;
        issues.push(`在线文档 ${url}：${String(error.message).split('\n')[0]}`);
      }
    }
    return { evidence, issues };
  } finally {
    signal.removeEventListener('abort', stop);
    await browser.close().catch(() => {});
  }
}

export function loadBrowserRuntime(dirs) {
  for (const dir of dirs.filter(Boolean)) {
    const require = createRequire(path.join(path.resolve(dir), 'package.json'));
    for (const name of ['playwright', '@playwright/test']) {
      try {
        const runtime = require(name);
        if (runtime.chromium) return runtime;
      } catch {
        /* next runtime */
      }
    }
  }
  throw new Error(
    '缺少 Playwright 浏览器运行时：请在源码项目或 Lantern 安装目录准备 playwright 与 Chromium 后重试',
  );
}
const UNSAFE =
  /删除|保存|提交|审批|审核通过|发送|支付|退出|注销|启用|禁用|重置|导入|导出|新增|创建|remove|delete|submit|save|approve|send|pay|logout|signout|reset|create|export|import/i;
export function readableUrl(raw, base) {
  try {
    const url = new URL(raw, base);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.origin !== new URL(base).origin ||
      UNSAFE.test(decodeURIComponent(url.pathname + url.search))
    )
      return null;
    url.searchParams.sort();
    return url.href;
  } catch {
    return null;
  }
}
export async function collectPages(root, system, config, { signal, onProgress }) {
  const evidence = [],
    issues = [];
  let collectedChars = 0;
  const maxChars = config.maxChars ?? 2000000;
  const addPage = (ref, content, title) => {
    const remaining = Math.max(0, maxChars - collectedChars);
    if (content.length > remaining && !issues.some((issue) => issue.includes('正文预算')))
      issues.push('页面来源达到正文预算，结果为部分覆盖');
    content = content.slice(0, remaining);
    collectedChars += content.length;
    if (content.trim()) evidence.push(makeEvidence('page', ref, content, title));
  };
  if (!config.sources.page.enabled) return { evidence, issues };
  if (
    system.id &&
    businessLoginRequired(root, system.id) &&
    !resolveBusinessLoginState(root, system)
  )
    return { evidence, issues: ['登录态失效：请先在系统登录配置完成登录并保存登录态'] };
  const entry = config.entryUrl || system.entryUrl;
  if (!readableUrl(entry, entry))
    return { evidence, issues: ['系统入口不是可只读访问的 HTTP 地址'] };
  const runtime = loadBrowserRuntime([
    config.runtimeDir,
    config.sourceDir,
    system.sourceDir,
    fileURLToPath(new URL('../..', import.meta.url)),
    process.cwd(),
  ]);
  const browser = await runtime.chromium.launch({ headless: true });
  const stop = () => void browser.close().catch(() => {});
  signal.addEventListener('abort', stop, { once: true });
  try {
    let storageState;
    const loginStateFile = system.id
      ? resolveBusinessLoginState(root, system)
      : system.loginState
        ? path.resolve(system.sourceDir || root, system.loginState)
        : '';
    if (loginStateFile) {
      const file = loginStateFile;
      if (!fs.existsSync(file)) throw new Error('登录态文件不存在，请在系统设置更新');
      storageState = JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    const context = await browser.newContext({
      storageState,
      serviceWorkers: 'block',
      acceptDownloads: false,
    });
    await context.route('**/*', async (route) => {
      const request = route.request();
      const url = request.url();
      if (
        !['GET', 'HEAD', 'OPTIONS'].includes(request.method()) ||
        UNSAFE.test(new URL(url).pathname + new URL(url).search) ||
        (request.isNavigationRequest() && !readableUrl(url, entry))
      ) {
        if (issues.length < 200)
          issues.push(`只读拦截：${request.method()} ${new URL(url).pathname}`);
        return route.abort();
      }
      return route.continue();
    });
    await context.addInitScript(() => {
      window.WebSocket = class {
        constructor() {
          throw new Error('业务地图只读采集不开放 WebSocket');
        }
      };
      navigator.sendBeacon = () => false;
    });
    const page = await context.newPage();
    const queue = [{ url: entry, depth: 0 }, ...config.pageUrls.map((url) => ({ url, depth: 0 }))],
      seen = new Set();
    while (queue.length && seen.size < config.maxPages && collectedChars < maxChars) {
      signal.throwIfAborted();
      const next = queue.shift();
      const url = readableUrl(next.url, entry);
      if (!url || seen.has(url) || next.depth > config.maxDepth) continue;
      seen.add(url);
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(400);
        if (await hasLoginChallenge(page)) {
          issues.push('登录态失效：检测到登录页面，请更新登录态后重试');
          break;
        }
        const snapshot = await page.evaluate(() => ({
          title: document.title,
          text: document.body.innerText.slice(0, 24000),
          links: Array.from(document.querySelectorAll('a[href]'))
            .map((e) => ({ url: e.href, title: e.innerText }))
            .filter((item) => item.url && item.title),
          controls: Array.from(
            document.querySelectorAll('button,input,select,textarea,[role=button],[role=tab]'),
          )
            .slice(0, 150)
            .map((e) => ({
              role: e.getAttribute('role') || e.tagName,
              label:
                e.getAttribute('aria-label') ||
                e.innerText ||
                e.getAttribute('placeholder') ||
                e.getAttribute('name'),
            })),
        }));
        addPage(
          page.url(),
          `${snapshot.title}\n${snapshot.text}\n页面动作（仅观察，未执行）：${JSON.stringify(snapshot.controls)}`,
          snapshot.title,
        );
        onProgress('pages', page.url());
        const terms =
          config.scope?.targets
            .flatMap((target) => [target.name, target.description])
            .filter(Boolean) || [];
        const relevant = (link) =>
          config.scope?.mode === 'system' ||
          !terms.length ||
          next.depth === 0 ||
          terms.some((term) => (link.title + link.url).includes(term));
        for (const link of snapshot.links)
          if (!UNSAFE.test(link.title) && relevant(link))
            queue.push({ url: link.url, depth: next.depth + 1 });
        // SPA 菜单通常没有 href；仅操作具有明确菜单/树节点语义的控件。
        const menus = page.locator('[role=menuitem], [role=treeitem], button[aria-expanded=false]');
        const menuCount = Math.min(await menus.count(), 20);
        for (let i = 0; i < menuCount && collectedChars < maxChars; i++) {
          signal.throwIfAborted();
          const menu = menus.nth(i),
            name = await menu.innerText().catch(() => '');
          if (!name || UNSAFE.test(name) || !relevant({ title: name, url: '' })) continue;
          const before = page.url();
          await menu.click({ timeout: 2000 }).catch(() => {});
          await page.waitForTimeout(150);
          const result = await page.evaluate(() => ({
            text: document.body.innerText.slice(0, 24000),
            links: Array.from(document.querySelectorAll('a[href]')).map((e) => ({
              url: e.href,
              title: e.innerText,
            })),
          }));
          addPage(
            page.url() + '#menu=' + encodeURIComponent(name),
            result.text,
            snapshot.title + ' / ' + name,
          );
          for (const link of result.links)
            if (!UNSAFE.test(link.title) && relevant(link))
              queue.push({ url: link.url, depth: next.depth + 1 });
          if (page.url() !== before)
            await page.goto(before, { waitUntil: 'domcontentloaded', timeout: 15000 });
        }
        // 非导航控件仅展开明确的标签/菜单；不点击普通业务按钮。
        const tabs = page.locator('[role=tab]');
        const count = Math.min(await tabs.count(), 12);
        for (let i = 0; i < count && collectedChars < maxChars; i++) {
          signal.throwIfAborted();
          const tab = tabs.nth(i),
            name = await tab.innerText();
          if (UNSAFE.test(name)) continue;
          await tab.click({ timeout: 3000 }).catch(() => {});
          await page.waitForTimeout(150);
          const body = await page.locator('body').innerText();
          addPage(
            `${page.url()}#tab=${encodeURIComponent(name)}`,
            body.slice(0, 24000),
            `${snapshot.title} / ${name}`,
          );
        }
      } catch (error) {
        if (signal.aborted) throw error;
        issues.push(`页面 ${url}：${error.message.split('\n')[0]}`);
      }
    }
    if (queue.length) issues.push('已达到页面数量或深度上限，未覆盖所有发现页面');
    return { evidence, issues };
  } finally {
    signal.removeEventListener('abort', stop);
    await browser.close().catch(() => {});
  }
}

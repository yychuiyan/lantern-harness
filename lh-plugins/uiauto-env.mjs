/**
 * 项目环境配置：读写项目里的 `.env` / `.env.<ENV>` 文件。
 *
 * 口径：
 * - **文件是唯一真相**：平台只做「读 → 打码 → 改动的 key」,不另存一份配置 JSON，
 *   避免 `.env` 与界面两边漂移；CLI 跑的时候读到的就是面板改过的同一份文件。
 * - **字段归项目，不归平台**：界面上的分组与中文说明来自项目自己的 `.env.example`
 *   （`readEnvSchema`），平台只约定 `ENV` / `BASE_URL` / `ALLOW_PROD` 三条运行契约。
 * - 只动命中的 `KEY=` 行：注释、空行、未知变量、用户自己的写法原样保留。
 * - 密钥只回 `hasValue`，不回传明文；未改动的密钥保存时保留旧值。
 * - 不生成 `config.ts` / `playwright.config.ts`：那是骨架与 AI 检查的范畴。
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * 平台约定的 3 条契约 key：接口只要它们一定在界面上，
 * 因为它们被骨架的 `utils/env-loader.ts` / `playwright.config.ts` 直接消费。
 */
export const PLATFORM_ENV_KEYS = [
  { key: 'ENV', label: '环境名', readOnly: true, hint: '由环境文件名决定，改名请新建环境' },
  { key: 'BASE_URL', label: '被测地址', hint: '去掉结尾斜杠' },
  {
    key: 'ALLOW_PROD',
    label: '允许生产运行',
    hint: 'prod 环境必须为 true，否则 env-loader 拒绝运行',
  },
];

/** 环境变量模板文件名：`.env.example` / `.env.dev.example` / ... */
const EXAMPLE_FILE = /^\.env(?:\.[a-z0-9_-]+)?\.example$/;

/** 模板文件（schema）候选顺序：优先共用 `.env.example`，再按环境名兜底 */
const EXAMPLE_CANDIDATES = ['.env.example'];

/** 密钥判定：名字里像密钥的变量 */
const SECRET_NAME = /(PASSWORD|PASSWD|TOKEN|SECRET|API_?KEY|PRIVATE_KEY|CREDENTIAL|COOKIE)/i;

const ENV_LINE = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

/** 本机回环地址：prod 配到这儿说明环境选错了（与骨架 env-loader 的判定保持一致） */
const LOOPBACK_HOST = /^(https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|$)/i;

const ENV_NAME = /^[a-z][a-z0-9_-]{0,19}$/;

/** 环境名合法性：小写字母开头，只允许小写字母 / 数字 / `_` / `-`；空串表示 `.env` 共用默认 */
export function sanitizeEnvName(name) {
  const value = String(name ?? '').trim();
  if (!value) return '';
  return ENV_NAME.test(value) ? value : '';
}

export function isEnvNameValid(name) {
  const value = String(name ?? '').trim();
  return !value || ENV_NAME.test(value);
}

/**
 * 骨架自带的固定环境：`.env`（各环境共用的兜底）与 `.env.prod`。
 * 它们属于框架约定，不给删除入口；只有用户自己新建的 `.env.<ENV>` 才能删。
 */
export function isSkeletonEnv(name) {
  const value = sanitizeEnvName(name);
  return value === '' || value === 'prod';
}

/** 是不是环境变量模板文件（`.env.example` 及按环境拆的变体） */
export function isExampleFileName(name) {
  return EXAMPLE_FILE.test(String(name ?? '').trim());
}

/** 平台约定 key 的元数据；其它 key 返回 null（说明归项目模板管） */
export function envKeyMeta(key) {
  return PLATFORM_ENV_KEYS.find((item) => item.key === key) ?? null;
}

export function isSecretKey(key) {
  return SECRET_NAME.test(String(key ?? ''));
}

/**
 * 拆一行的值：支持引号、未加引号的 ` # 注释`。
 * `KEY=` 空值与 `KEY="a # b"` 都要还原成真正的值。
 */
export function parseEnvValue(rawValue) {
  const raw = String(rawValue ?? '');
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    let out = '';
    for (let index = 1; index < trimmed.length; index += 1) {
      const char = trimmed[index];
      if (char === '\\' && quote === '"' && index + 1 < trimmed.length) {
        out += trimmed[index + 1];
        index += 1;
        continue;
      }
      if (char === quote) return out;
      out += char;
    }
    return out;
  }
  const commentAt = trimmed.search(/\s#/);
  return (commentAt >= 0 ? trimmed.slice(0, commentAt) : trimmed).trim();
}

/** 一行的值 + 行尾注释：替换值时把用户写的注释一起保留 */
function splitValueAndComment(rawValue) {
  const raw = String(rawValue ?? '');
  const trimmed = raw.trim();
  if (!trimmed) return { value: '', comment: '' };
  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    let index = 1;
    for (; index < trimmed.length; index += 1) {
      if (trimmed[index] === '\\' && quote === '"') {
        index += 1;
        continue;
      }
      if (trimmed[index] === quote) break;
    }
    if (index >= trimmed.length) return { value: parseEnvValue(trimmed), comment: '' };
    return {
      value: parseEnvValue(trimmed.slice(0, index + 1)),
      comment: trimmed.slice(index + 1).trim(),
    };
  }
  const commentAt = trimmed.search(/\s#/);
  if (commentAt < 0) return { value: trimmed, comment: '' };
  return { value: trimmed.slice(0, commentAt).trim(), comment: trimmed.slice(commentAt).trim() };
}

/**
 * 写回时的值格式：含空格 / `#` / 引号时加引号。
 * 优先用单引号（dotenv 对单引号只做去引号、不处理转义，JSON 里的 `"` 不用转义）；
 * 值里有单引号时退回双引号，三种引号都有才用反斜杠转义（极少见）。
 */
export function formatEnvValue(value) {
  const text = String(value ?? '');
  if (!text) return '';
  if (!/[\s#'"`]/.test(text) && text === text.trim()) return text;
  if (!text.includes("'")) return `'${text}'`;
  if (!text.includes('"')) return `"${text}"`;
  if (!text.includes('`')) return `\`${text}\``;
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * 解析 `.env` 文本：保留原始行，同时给出每个 KEY 的值与所在行号。
 * 只认 `KEY=value` / `export KEY=value` 两种写法，其它行（注释、空行）原样留着。
 *
 * 注释分两种（界面上「其它变量」靠它还原用户自己的结构）：
 * - `section`：前面的注释块与上一个 KEY 之间隔了空行（或就在文件开头），
 *   视为分节标题，例如 `# SIP 自动应答（UDP）`；
 * - `comment`：注释块紧贴在上一个 KEY 下面，视为这个 KEY 的字段说明，
 *   例如 `# 签入坐席工号`。
 */
export function parseEnvText(raw) {
  const source = String(raw ?? '').replace(/\r\n/g, '\n');
  const trailingNewline = source.endsWith('\n');
  const body = trailingNewline ? source.slice(0, -1) : source;
  const lines = body === '' ? [] : body.split('\n');
  const entries = [];
  let comments = [];
  // 上一个 KEY 之后出现过空行（文件开头也算）：下一次注释就是分节标题
  let blank = true;
  lines.forEach((line, index) => {
    const matched = ENV_LINE.exec(line);
    if (!matched) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#')) comments.push(trimmed.replace(/^#+\s*/, ''));
      else {
        comments = [];
        blank = true;
      }
      return;
    }
    const label = comments.join(' / ');
    const isSection = Boolean(label) && blank;
    entries.push({
      key: matched[2],
      value: parseEnvValue(matched[3]),
      line: index,
      comment: isSection ? '' : label,
      section: isSection ? label : '',
    });
    comments = [];
    blank = false;
  });
  return { lines, entries, trailingNewline };
}

/**
 * 批量粘贴导入：把一段 `.env` 文本合并进现有文件。
 *
 * - 文件里已有的 key：只换值（保留原有行与行尾注释）；
 * - 文件里没有的 key：连它上面的注释一起，按粘贴顺序整段追加到末尾——
 *   这样用户从别的项目搬过来的分节注释不会丢；
 * - 只认合法 `KEY=value`，注释 / 空行只在「新增」时保留。
 */
export function mergeEnvText(original, pasted) {
  const incoming = parseEnvText(pasted);
  const existingEntries = parseEnvText(original).entries;
  const existing = new Set(existingEntries.map((entry) => entry.key));
  const existingValues = new Map(
    existingEntries.map((entry) => [entry.key, String(entry.value ?? '')]),
  );
  const updates = {};
  const block = [];
  const added = new Set();
  /** 紧挨在下一个 KEY 上面的注释 / 空行：只在「新增这个 key」时保留 */
  let buffer = [];
  const source = String(pasted ?? '').replace(/\r\n/g, '\n');
  for (const line of source.split('\n')) {
    const matched = ENV_LINE.exec(line);
    if (!matched) {
      buffer.push(line.trimEnd());
      continue;
    }
    const key = matched[2];
    if (existing.has(key)) {
      const nextValue = parseEnvValue(matched[3]);
      // 粘贴里留空（模板常见写法）不覆盖文件里已有的值，等同「留空不改」
      const keepExisting = nextValue === '' && existingValues.get(key) !== '';
      if (!(key in updates) && !keepExisting) updates[key] = nextValue;
      buffer = [];
      continue;
    }
    if (added.has(key)) {
      buffer = [];
      continue;
    }
    added.add(key);
    block.push(...buffer, line.trimEnd());
    buffer = [];
  }
  // 去掉块首尾的空行（粘贴时常带上前后的空行）
  while (block.length && !block[0].trim()) block.shift();
  while (block.length && !block[block.length - 1].trim()) block.pop();
  if (!Object.keys(updates).length && !block.length) {
    return { text: String(original ?? ''), updated: 0, created: 0, total: incoming.entries.length };
  }
  let next = patchEnvText(original, updates);
  if (block.length) {
    next = next.replace(/\n+$/, '');
    if (next) next += '\n\n';
    next += `${block.join('\n')}\n`;
  }
  return {
    text: next,
    updated: Object.keys(updates).length,
    created: added.size,
    total: incoming.entries.length,
  };
}

/**
 * 只改命中的行：
 * - `updates` 里的 key 替换值（保留缩进 / `export ` / 行尾注释）；
 * - `remove` 里的 key 整行删掉；
 * - 缺失的 key 追加到末尾（先补一个分隔空行，避免和上面挤在一起）；
 * - 没在 `updates` / `remove` 里的行一个字符都不动。
 */
export function patchEnvText(original, updates = {}, remove = []) {
  const parsed = parseEnvText(original);
  const pending = new Map(
    Object.entries(updates ?? {})
      .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(String(key)))
      .map(([key, value]) => [key, String(value ?? '')]),
  );
  const removeSet = new Set((remove ?? []).map((key) => String(key)));
  const seen = new Set();
  const out = [];

  for (const line of parsed.lines) {
    const matched = ENV_LINE.exec(line);
    if (!matched) {
      out.push(line);
      continue;
    }
    const key = matched[2];
    if (removeSet.has(key)) {
      seen.add(key);
      continue;
    }
    if (!pending.has(key)) {
      out.push(line);
      seen.add(key);
      continue;
    }
    const { comment } = splitValueAndComment(matched[3]);
    const nextValue = formatEnvValue(pending.get(key));
    out.push(`${matched[1]}${key}=${nextValue}${comment ? ` ${comment}` : ''}`);
    seen.add(key);
  }

  const appended = [];
  for (const [key, value] of pending) {
    if (seen.has(key) || removeSet.has(key)) continue;
    appended.push(`${key}=${formatEnvValue(value)}`);
  }
  if (appended.length) {
    while (out.length && !out[out.length - 1].trim()) out.pop();
    if (out.length) out.push('');
    out.push(...appended);
    out.push('');
  }

  const body = out.join('\n');
  if (!body) return parsed.trailingNewline && original ? '\n' : '';
  // 结尾空行已经由追加逻辑补上；用户原来怎么结尾就怎么结尾
  if (appended.length) return body;
  return parsed.trailingNewline ? `${body}\n` : body;
}

/** 打码：密钥只回 `hasValue`，界面拿不到明文 */
export function maskEnvEntries(entries) {
  return entries.map((entry) => {
    const secret = isSecretKey(entry.key);
    return {
      key: entry.key,
      value: secret ? '' : entry.value,
      hasValue: Boolean(entry.value),
      secret,
      // 是否平台契约 key（ENV / BASE_URL / ALLOW_PROD）：说明文案归平台，其余归项目模板
      platform: Boolean(envKeyMeta(entry.key)),
      // 文件里这个 KEY 上面的分节注释 / 字段注释：界面用它还原用户自己的结构
      comment: String(entry.comment ?? '').slice(0, 200),
      section: String(entry.section ?? '').slice(0, 200),
    };
  });
}

/** 环境名 → 文件名（空串表示 `.env`） */
export function envFileName(env) {
  const name = sanitizeEnvName(env);
  return name ? `.env.${name}` : '.env';
}

/** 环境名 → 项目里的绝对路径；名字非法返回空串 */
export function envFilePath(dir, env) {
  if (!isEnvNameValid(env)) return '';
  return path.join(path.resolve(dir), envFileName(env));
}

/** 项目里已有哪些环境文件；`env: ''` 表示共用的 `.env`；模板文件不算环境 */
export function scanEnvFiles(dir) {
  const list = [];
  try {
    if (fs.existsSync(path.join(dir, '.env'))) list.push({ env: '', file: '.env' });
    for (const name of fs.readdirSync(dir)) {
      if (isExampleFileName(name)) continue;
      const matched = /^\.env\.([A-Za-z0-9_-]+)$/.exec(name);
      if (!matched) continue;
      list.push({ env: matched[1].toLowerCase(), file: name });
    }
  } catch {
    return [];
  }
  return list.sort((a, b) => (a.env === '' ? -1 : b.env === '' ? 1 : a.env.localeCompare(b.env)));
}

/** 旧骨架把模板写成了 `.env.dev.example` / `.env.test.example`：统一改名成共用的 `.env.example` */
const LEGACY_EXAMPLE_FILES = ['.env.dev.example', '.env.uat.example', '.env.test.example'];

export function migrateLegacyExampleFile(dir) {
  const root = path.resolve(dir);
  const target = path.join(root, '.env.example');
  if (fs.existsSync(target)) return '';
  for (const legacy of LEGACY_EXAMPLE_FILES) {
    const abs = path.join(root, legacy);
    if (!fs.existsSync(abs)) continue;
    try {
      // 模板里的 ENV 只是占位（新建环境时按文件名重写），老文件里的 dev / test 一并清掉
      const text = fs.readFileSync(abs, 'utf8').replace(/^\s*ENV\s*=.*$/m, 'ENV=');
      fs.writeFileSync(target, text, 'utf8');
      fs.unlinkSync(abs);
      return legacy;
    } catch {
      return '';
    }
  }
  return '';
}

/** 项目里实际当 schema 的模板文件绝对路径；没有返回空串 */
export function envExampleFile(dir) {
  const root = path.resolve(dir);
  for (const name of EXAMPLE_CANDIDATES) {
    const abs = path.join(root, name);
    if (fs.existsSync(abs)) return abs;
  }
  // 没有共用模板就退到按环境拆的：`.env.test.example` / `.env.prod.example` / 任意 `.env.*.example`（按名字排序）
  try {
    const found = fs
      .readdirSync(root)
      .filter((name) => isExampleFileName(name))
      .sort((a, b) => (a === '.env.example' ? -1 : b === '.env.example' ? 1 : a.localeCompare(b)));
    return found.length ? path.join(root, found[0]) : '';
  } catch {
    return '';
  }
}

/** 模板里的值只当 placeholder：空值、占位符模板、密钥类都不展示 */
function templatePlaceholder(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  // `{{password}}` / `{"token":"${token}"}` 这种是模板，不是真实示例
  if (text.includes('{{') || text.includes('${')) return '';
  if (/password|passwd|secret|token/i.test(text)) return '';
  return text.length > 60 ? '' : text;
}

/** `# KEY=value`：注释状态的可选变量，schema 里也要露出来 */
const COMMENTED_ENV_LINE = /^\s*#+\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

/**
 * 读 `.env.example` 当项目的字段 schema：key 顺序、分组标题、字段中文说明都来自它。
 *
 * 注释约定：
 * - 空行隔开的单个 `# 标题` → 下一个 key 的字段名；块里有多个 key 时升级成组标题；
 * - 连着两行注释 `# 分组` + `# 字段说明` → 第一行是组标题，其余是字段说明；
 * - 空行之后才出现的注释 → 组标题；紧贴 key 的注释 → 字段说明；
 * - `# KEY=值` 按「可选字段」收进 schema（模板里注释掉、要用再打开）。
 */
export function readEnvSchema(dir) {
  const file = envExampleFile(dir);
  if (!file) return { source: '', blocks: [], keys: [] };
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { source: '', blocks: [], keys: [] };
  }
  const blocks = [];
  /** 紧贴 key 上方的注释块 */
  let pending = [];
  /** 空行之上留下的注释：视为下一个分组的标题 */
  let header = '';

  const pushKey = (key, rawValue, optional) => {
    let title = header;
    let label = '';
    let hint = '';
    if (pending.length === 1) {
      if (title) hint = pending[0];
      else label = pending[0];
    } else if (pending.length > 1) {
      const groupTitle = pending[0];
      title = title || groupTitle;
      hint = pending.slice(title === groupTitle ? 1 : 0).join(' / ');
    }
    const last = blocks[blocks.length - 1];
    // 显式的组标题变了、或这个 key 自带一行字段名 → 另起一段；否则接到上一段
    if (!last || (title && last.title !== title) || label) {
      blocks.push({ title: title || '', keys: [] });
    }
    blocks[blocks.length - 1].keys.push({
      key,
      label,
      hint,
      placeholder: templatePlaceholder(rawValue),
      ...(optional ? { optional: true } : {}),
    });
    pending = [];
    header = '';
  };

  for (const line of String(text ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')) {
    const matched = ENV_LINE.exec(line);
    if (matched) {
      pushKey(matched[2], matched[3], false);
      continue;
    }
    const commented = COMMENTED_ENV_LINE.exec(line);
    if (commented) {
      pushKey(commented[1], commented[2], true);
      continue;
    }
    const trimmed = line.trim();
    if (trimmed) {
      pending.push(trimmed.replace(/^#+\s*/, ''));
    } else {
      // 空行：上面攒的注释成为「分组标题」，等下一个 key 落地
      if (pending.length) header = pending.join(' / ');
      pending = [];
    }
  }
  // 分组里第一个 key 带了 label、后来又并进别的 key：label 升级成组标题
  for (const block of blocks) {
    if (block.keys.length > 1 && !block.title) {
      const first = block.keys[0];
      if (first.label) {
        block.title = first.label;
        first.label = '';
      }
    }
  }
  // 单 key 分组：标题就是字段名，省掉重复的组标题
  const out = blocks.map((block) =>
    block.keys.length === 1 && block.title
      ? {
          title: '',
          keys: [{ ...block.keys[0], label: block.title }],
        }
      : block,
  );
  return {
    source: path.basename(file),
    blocks: out.filter((block) => block.keys.length),
    keys: out.flatMap((block) => block.keys.map((item) => item.key)),
  };
}

/**
 * 扫项目里所有 `.env` / `.env.*`（排除模板），只取 key 名：
 * 界面用它给当前环境标注「这个 key 在 test / prod 里已经配过」，不用用户一条条加。
 */
export function readEnvKeyMatrix(dir, currentEnv = '') {
  const root = path.resolve(dir);
  const current = sanitizeEnvName(currentEnv);
  const keyEnvs = {};
  const envKeys = {};
  let files = [];
  try {
    files = fs
      .readdirSync(root)
      .filter((name) => /^\.env(\.[A-Za-z0-9_-]+)?$/.test(name) && !isExampleFileName(name));
  } catch {
    return { keyEnvs: {}, envKeys: {} };
  }
  for (const name of files.sort()) {
    const matched = /^\.env\.([A-Za-z0-9_-]+)$/.exec(name);
    const env = matched ? matched[1].toLowerCase() : '';
    if (env === current) continue;
    let keys = [];
    try {
      keys = parseEnvText(fs.readFileSync(path.join(root, name), 'utf8'))
        .entries.filter((entry) => entry.key !== 'ENV' && String(entry.value ?? '').trim())
        .map((entry) => entry.key)
        .slice(0, 300);
    } catch {
      continue;
    }
    envKeys[env] = keys;
    for (const key of keys) {
      if (!keyEnvs[key]) keyEnvs[key] = [];
      if (!keyEnvs[key].includes(env)) keyEnvs[key].push(env);
    }
  }
  return { keyEnvs, envKeys };
}

/**
 * 项目是不是按 `ENV` + `.env.<ENV>` 这套约定做的：
 * 有 `.env.example`，或 `package.json` 里出现 `cross-env ENV=`.
 */
export function hasEnvConvention(dir) {
  try {
    if (fs.existsSync(path.join(dir, '.env.example'))) return true;
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const scripts = pkg?.scripts ?? {};
    return Object.values(scripts).some((command) => /cross-env\s+ENV=/i.test(String(command)));
  } catch {
    return false;
  }
}

/**
 * `.auth/` 下的登录态文件（切环境后通常要清理）。
 * 不写死文件名：骨架可能存 admin / user，也可能按业务角色自定义。
 */
export function listAuthStateFiles(dir) {
  const root = path.join(dir, '.auth');
  try {
    if (!fs.statSync(root).isDirectory()) return [];
    return fs
      .readdirSync(root)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => `.auth/${name}`);
  } catch {
    return [];
  }
}

/**
 * 保存前校验：只报「一定会出问题」的，别拦着用户存半份配置。
 * 业务字段（账号 / 接口登录等）由项目模板决定，这里只做通用推断 + 平台契约检查。
 * 返回 `{ errors, warnings }`，都是 `{ key, message }`。
 */
export function validateEnvEntries(entries = {}, env = '') {
  const errors = [];
  const warnings = [];
  const keys = Object.keys(entries ?? {});
  const get = (key) => String(entries[key] ?? '').trim();
  const baseURL = get('BASE_URL');
  if (baseURL) {
    if (!/^https?:\/\//i.test(baseURL)) {
      errors.push({ key: 'BASE_URL', message: 'BASE_URL 必须以 http:// 或 https:// 开头' });
    }
    if (baseURL.endsWith('/')) {
      warnings.push({
        key: 'BASE_URL',
        message: 'BASE_URL 结尾有 /，建议去掉（拼路径时容易多一层）',
      });
    }
  }
  // 账号配对：不认具体角色名，只看 `*_USERNAME` / `*_USER` 与同前缀的 `*_PASSWORD` / `*_PASSWD` 是否成对
  for (const key of keys) {
    const matched = /^(.*_)?(USERNAME|USER)$/.exec(key);
    if (!matched) continue;
    const prefix = matched[1] ?? '';
    const passKey = ['PASSWORD', 'PASSWD']
      .map((suffix) => `${prefix}${suffix}`)
      .find((candidate) => keys.includes(candidate));
    if (!passKey) continue;
    if (Boolean(get(key)) !== Boolean(get(passKey))) {
      warnings.push({
        key: passKey,
        message: `${key} 与 ${passKey} 要成对填写，只填一半登录会失败`,
      });
    }
  }
  if (sanitizeEnvName(env) === 'prod' && get('ALLOW_PROD') !== 'true') {
    // 只提示不拦：文件可以先存着，真正跑 prod 时由项目里的 env-loader 硬性拒绝
    warnings.push({
      key: 'ALLOW_PROD',
      message: 'prod 已保存，但运行前需把 ALLOW_PROD 改成 true，否则 env-loader 会直接拒绝执行',
    });
  }
  if (sanitizeEnvName(env) === 'prod') {
    // `.env` 被忽略、不随仓库分发：prod 少了 BASE_URL 会落到 config 兜底（本机地址），
    // 看着跑完了其实打的是本机，所以面板这里也要点出来（真正拦截在 env-loader）
    if (!baseURL) {
      warnings.push({
        key: 'BASE_URL',
        message: 'prod 必须显式填 BASE_URL：.env 不随仓库分发，缺了 env-loader 会直接拒绝运行',
      });
    } else if (LOOPBACK_HOST.test(baseURL)) {
      warnings.push({
        key: 'BASE_URL',
        message: `prod 的 BASE_URL 指向本机地址（${baseURL}），env-loader 会拒绝运行，请改成生产域名`,
      });
    }
  }
  return { errors, warnings };
}

/**
 * 任务命令与所选 ENV 冲突：命令里写死了 `ENV=uat`，shell 里后设的值会盖掉面板选择。
 * 返回提示文案，没冲突返回空串。
 */
export function envTaskMismatch(command, envName) {
  const selected = sanitizeEnvName(envName);
  if (!selected) return '';
  const text = String(command ?? '');
  const found = new Set();
  const re = /(?:^|[\s;&|(])ENV\s*=\s*([A-Za-z0-9_-]+)/g;
  let matched;
  while ((matched = re.exec(text))) found.add(matched[1].toLowerCase());
  const conflict = [...found].find((name) => name !== selected);
  if (!conflict) return '';
  return `这条任务命令里写死了 ENV=${conflict}，会覆盖面板选的 ENV=${selected}；换一条不带 ENV= 的任务，或把环境选成 ${conflict}。`;
}

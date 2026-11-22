/**
 * 平台侧 SSO / 接口登录：读项目 env → 调 LOGIN_API → 写入 Playwright storageState。
 * 不跑项目里的 auth.setup（那条见 uiauto-auth-setup.mjs）。
 * 给登录墙自动链与手动选 SSO 共用。
 *
 * 登录接口地址：优先骨架约定键，再通配 `LOGIN_API_*`（排除 BODY / TOKEN 等非地址字段）。
 */
import fs from 'node:fs';
import path from 'node:path';

import { envFilePath, parseEnvText, sanitizeEnvName } from './uiauto-env.mjs';

const AUTH_REL = path.join('.auth', 'admin.json');

/** 骨架 / 常见别名：有值时优先按此顺序取 */
export const LOGIN_API_ENDPOINT_KEYS = [
  'LOGIN_API_PATH',
  'LOGIN_API_URL',
  'LOGIN_API_ENDPOINT',
  'LOGIN_URL',
];

/**
 * `LOGIN_API_*` 里不算「接口地址」的后缀（请求体、token 路径、头等）。
 * 其余后缀走通配，例如 LOGIN_API_SSO_URL、LOGIN_API_HOST。
 */
export const LOGIN_API_ENDPOINT_DENY_SUFFIXES = [
  'BODY',
  'TOKEN_PATH',
  'TOKEN_KEY',
  'TOKEN_STORAGE_KEY',
  'METHOD',
  'HEADERS',
  'HEADER',
  'TIMEOUT',
  'CONTENT_TYPE',
  'TYPE',
];

const ENDPOINT_DENY_RE = new RegExp(`^(${LOGIN_API_ENDPOINT_DENY_SUFFIXES.join('|')})$`, 'i');

function looksLikeEndpoint(value) {
  const v = String(value || '').trim();
  if (!v) return 0;
  if (/^https?:\/\//i.test(v)) return 3;
  if (v.startsWith('/')) return 2;
  // 主机或相对路径也尽量认，分最低
  if (/^[a-z0-9.-]+\/[a-z0-9/_.-]+$/i.test(v) || /^[a-z0-9_./-]+$/i.test(v)) return 1;
  return 0;
}

function isDeniedLoginApiKey(key) {
  const raw = String(key || '');
  if (!/^LOGIN_API_/i.test(raw)) return true;
  const suffix = raw.slice('LOGIN_API_'.length);
  return ENDPOINT_DENY_RE.test(suffix);
}

/**
 * 从 env map 里取出登录接口地址（相对 path 或完整 URL）。
 * 1) 优先 LOGIN_API_PATH / URL / ENDPOINT / LOGIN_URL
 * 2) 再通配其它 `LOGIN_API_*`（排除 BODY、TOKEN_* 等）
 * @returns {{ key: string, value: string }}
 */
export function resolveLoginApiEndpoint(envMap = {}) {
  const map = envMap && typeof envMap === 'object' ? envMap : {};
  for (const key of LOGIN_API_ENDPOINT_KEYS) {
    const value = String(map[key] ?? '').trim();
    if (value) return { key, value };
  }

  /** @type {Array<{ key: string, value: string, score: number }>} */
  const wild = [];
  for (const [key, raw] of Object.entries(map)) {
    if (isDeniedLoginApiKey(key)) continue;
    // 已在优先列表里扫过
    if (LOGIN_API_ENDPOINT_KEYS.includes(key)) continue;
    const value = String(raw ?? '').trim();
    if (!value) continue;
    const score = looksLikeEndpoint(value);
    if (score <= 0) continue;
    wild.push({ key, value, score });
  }
  if (!wild.length) return { key: '', value: '' };
  wild.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
  return { key: wild[0].key, value: wild[0].value };
}

function readEnvFileMap(file) {
  if (!file || !fs.existsSync(file)) return {};
  try {
    const parsed = parseEnvText(fs.readFileSync(file, 'utf8'));
    const map = {};
    for (const entry of parsed.entries) {
      map[entry.key] = entry.value;
    }
    return map;
  } catch {
    return {};
  }
}

/** `.env` 打底，再叠 `.env.<ENV>`（后者覆盖） */
export function readProjectEnvMap(dir, envName = '') {
  const root = String(dir || '');
  if (!root) return {};
  const base = readEnvFileMap(envFilePath(root, ''));
  const env = sanitizeEnvName(envName);
  if (!env) return base;
  return { ...base, ...readEnvFileMap(envFilePath(root, env)) };
}

export function projectHasSsoConfig(dir, envName = '') {
  const map = readProjectEnvMap(dir, envName);
  return Boolean(resolveLoginApiEndpoint(map).value);
}

function renderBody(template, username, password) {
  return String(template || '')
    .replace(/\{\{\s*username\s*\}\}/g, username)
    .replace(/\{\{\s*password\s*\}\}/g, password);
}

function pickPath(source, target) {
  return String(target || '')
    .split('.')
    .filter(Boolean)
    .reduce((acc, key) => {
      if (acc && typeof acc === 'object') return acc[key];
      return undefined;
    }, source);
}

/** 未配 LOGIN_API_TOKEN_PATH 时按常见字段猜 token */
export const DEFAULT_TOKEN_PATHS = [
  'data.authorization',
  'data.token',
  'data.accessToken',
  'data.access_token',
  'data.data.token',
  'result.token',
  'result.access_token',
  'token',
  'access_token',
  'accessToken',
  'authorization',
];

/** 未配 LOGIN_TOKEN_STORAGE_KEY 时的默认 localStorage key */
export const DEFAULT_TOKEN_STORAGE_KEYS = ['token', 'access_token', 'accessToken'];

function asTokenString(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/** 在对象里按 key 名深挖 token（最多 5 层），适配 data.xxx 自定义字段 */
export function findTokenDeep(node, prefix = '', depth = 0) {
  if (depth > 5 || node == null || typeof node !== 'object') return null;
  const entries = Array.isArray(node) ? node.map((v, i) => [String(i), v]) : Object.entries(node);
  for (const [key, value] of entries) {
    const pathKey = prefix ? `${prefix}.${key}` : key;
    if (/token|jwt|access|authorization|ticket|session|sid/i.test(String(key))) {
      const token = asTokenString(value);
      if (token.length >= 8) return { token, path: pathKey };
    }
  }
  for (const [key, value] of entries) {
    if (value && typeof value === 'object') {
      const pathKey = prefix ? `${prefix}.${key}` : key;
      const hit = findTokenDeep(value, pathKey, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * 从登录响应 JSON 取 token：显式路径优先，否则扫常见字段，再深挖 data。
 * @returns {{ token: string, path: string }}
 */
export function resolveLoginToken(json, explicitPath = '') {
  const configured = String(explicitPath || '').trim();
  if (configured) {
    const token = asTokenString(pickPath(json, configured));
    if (token) return { token, path: configured };
  }
  if (!json || typeof json !== 'object') return { token: '', path: '' };
  for (const pathKey of DEFAULT_TOKEN_PATHS) {
    const token = asTokenString(pickPath(json, pathKey));
    if (token) return { token, path: pathKey };
  }
  // data 本身是 JWT / 长串
  const dataAsToken = asTokenString(json.data);
  if (dataAsToken.length >= 16) return { token: dataAsToken, path: 'data' };
  const deep = findTokenDeep(json);
  if (deep) return deep;
  return { token: '', path: '' };
}

/**
 * localStorage 写入用的 key：显式配置优先，否则默认 `token`。
 */
export function resolveTokenStorageKey(envMap = {}, fallback = 'token') {
  const map = envMap && typeof envMap === 'object' ? envMap : {};
  for (const key of [
    'LOGIN_TOKEN_STORAGE_KEY',
    'LOGIN_API_TOKEN_KEY',
    'LOGIN_API_STORAGE_KEY',
    'TOKEN_STORAGE_KEY',
  ]) {
    const value = String(map[key] ?? '').trim();
    if (value) return value;
  }
  return String(fallback || 'token').trim() || 'token';
}

function originFromBase(baseURL) {
  try {
    const u = new URL(String(baseURL || '').trim() || 'http://localhost');
    return u.origin;
  } catch {
    return 'http://localhost';
  }
}

function resolveLoginUrl(baseURL, apiPath) {
  const p = String(apiPath || '').trim();
  if (!p) return '';
  if (/^https?:\/\//i.test(p)) return p;
  const base = String(baseURL || '').replace(/\/+$/, '');
  if (!base) return p.startsWith('/') ? p : `/${p}`;
  return `${base}${p.startsWith('/') ? p : `/${p}`}`;
}

/**
 * 调接口登录并写 `.auth/admin.json`。
 * @returns {{ ok: true, storageState: string, tokenSaved: boolean } | { ok: false, error: string }}
 */
export async function runSsoLoginAndSave({ dir, envName = '', baseURL = '' }) {
  const root = String(dir || '');
  if (!root || !fs.existsSync(root)) {
    return { ok: false, error: '项目目录不存在' };
  }
  const env = readProjectEnvMap(root, envName);
  const endpoint = resolveLoginApiEndpoint(env);
  const apiPath = endpoint.value;
  if (!apiPath) {
    return {
      ok: false,
      error:
        '未配置登录接口地址。请在环境配置填写 LOGIN_API_PATH / LOGIN_API_URL，或其它 LOGIN_API_* 地址类变量。',
    };
  }
  const username = String(env.ADMIN_USERNAME || env.USER_USERNAME || '').trim();
  const password = String(env.ADMIN_PASSWORD || env.USER_PASSWORD || '').trim();
  if (!username || !password) {
    return { ok: false, error: '未配置 ADMIN_USERNAME / ADMIN_PASSWORD（或 USER_*）' };
  }
  const bodyTemplate =
    String(env.LOGIN_API_BODY || '').trim() ||
    '{"username":"{{username}}","password":"{{password}}"}';
  const url = resolveLoginUrl(baseURL || env.BASE_URL || '', apiPath);
  if (!url || !/^https?:\/\//i.test(url)) {
    return {
      ok: false,
      error: `无法拼出登录接口地址：请配置 BASE_URL，或在 ${endpoint.key || 'LOGIN_API_PATH'} 里写完整 URL`,
    };
  }

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: renderBody(bodyTemplate, username, password),
    });
  } catch (err) {
    return {
      ok: false,
      error: `请求登录接口失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const rawText = await response.text();
  let json = null;
  try {
    json = JSON.parse(rawText);
  } catch {
    json = null;
  }
  if (!response.ok) {
    return {
      ok: false,
      error: `登录接口返回 ${response.status}${rawText ? `：${rawText.slice(0, 200)}` : ''}`,
    };
  }

  const explicitTokenPath = String(env.LOGIN_API_TOKEN_PATH || env.LOGIN_TOKEN_PATH || '').trim();
  const { token, path: tokenPathUsed } = resolveLoginToken(json, explicitTokenPath);
  const storageKey = token ? resolveTokenStorageKey(env, 'token') : '';

  const cookies = [];
  const setCookie = [];
  if (typeof response.headers.getSetCookie === 'function') {
    setCookie.push(...response.headers.getSetCookie());
  }
  // 兼容没有 getSetCookie 的运行时：单条 set-cookie
  if (!setCookie.length) {
    const single = response.headers.get('set-cookie');
    if (single) setCookie.push(single);
  }
  for (const line of setCookie) {
    const [pair] = String(line).split(';');
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name) continue;
    try {
      const origin = new URL(url);
      cookies.push({
        name,
        value,
        domain: origin.hostname,
        path: '/',
        expires: -1,
        httpOnly: /httponly/i.test(line),
        secure: origin.protocol === 'https:',
        sameSite: 'Lax',
      });
    } catch {
      // ignore bad cookie
    }
  }

  // localStorage 必须挂在「打开业务页的 origin」上；登录接口域名常与 BASE_URL 不同，
  // 只写 API origin 时页面读不到 token → 业务请求变成 undefined / 非法请求。
  const appOrigin = originFromBase(baseURL || env.BASE_URL || '');
  const apiOrigin = originFromBase(url);
  const storageOrigins = [
    ...new Set([appOrigin, apiOrigin].filter((item) => item && item !== 'http://localhost')),
  ];
  if (!storageOrigins.length) storageOrigins.push(apiOrigin || appOrigin || 'http://localhost');

  const localStorage = [];
  if (token) {
    // 与常见 Playwright auth.setup 对齐：主 key 用 token（可用 LOGIN_TOKEN_STORAGE_KEY 覆盖）
    const primary = storageKey || 'token';
    localStorage.push({ name: primary, value: token });
    if (primary !== 'token') localStorage.push({ name: 'token', value: token });
  }
  // 许多中台（含本仓库挂载的热线项目）除 token 外还要 loginUser=整份 data，缺了会「非法请求」
  const loginUser =
    json && typeof json.data === 'object' && json.data
      ? json.data
      : json && typeof json === 'object'
        ? null
        : null;
  if (loginUser) {
    localStorage.push({ name: 'loginUser', value: JSON.stringify(loginUser) });
  }

  if (!cookies.length && !localStorage.length) {
    const sample =
      json && typeof json === 'object'
        ? ` 响应字段：${Object.keys(json).slice(0, 8).join(', ') || '(空)'}`
        : rawText
          ? ` 响应片段：${rawText.slice(0, 120)}`
          : '';
    return {
      ok: false,
      error:
        '接口已响应，但没有拿到可写入的 cookie / token。可配置 LOGIN_API_TOKEN_PATH（响应里 token 的路径）与 LOGIN_TOKEN_STORAGE_KEY（须与框架读取的 key 一致），或确认接口会 Set-Cookie。' +
        sample,
    };
  }

  const state = {
    cookies,
    origins: localStorage.length ? storageOrigins.map((origin) => ({ origin, localStorage })) : [],
  };
  const abs = path.join(root, AUTH_REL);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return {
    ok: true,
    storageState: AUTH_REL.replace(/\\/g, '/'),
    tokenSaved: Boolean(token && storageKey),
    tokenPath: tokenPathUsed || '',
    storageKey: storageKey || '',
  };
}

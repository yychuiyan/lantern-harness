/**
 * 本地网页搜索 / 获取代理：仅 `astro dev` 与 lantern-harness 一体服务可用。
 * 服务端代抓，绕过浏览器 CORS；搜索走 DuckDuckGo HTML。
 */
import dns from 'node:dns/promises';
import { shouldBlockHost, shouldBlockIp } from './web-fetch-policy.mjs';

const PREFIX = '/__tb_web';
const MAX_FETCH = 400_000;
const MAX_TEXT = 24_000;
const MAX_REDIRECTS = 8;
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 LanternHarness/0.1';

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function stripTags(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeBasicEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function unwrapDdgHref(href) {
  try {
    const u = new URL(href, 'https://duckduckgo.com');
    const uddg = u.searchParams.get('uddg');
    if (uddg) return decodeURIComponent(uddg);
    if (href.startsWith('http')) return href;
  } catch {
    // ignore
  }
  return href;
}

/**
 * @param {URL} parsed
 * @param {boolean} allowPrivate
 */
async function assertSafeDestination(parsed, allowPrivate) {
  if (!/^https?:$/i.test(parsed.protocol)) {
    return { error: 'only http/https allowed' };
  }
  if (shouldBlockHost(parsed.hostname, allowPrivate)) {
    return { error: 'blocked host' };
  }
  try {
    const records = await dns.lookup(parsed.hostname, { all: true, verbatim: true });
    for (const r of records) {
      if (shouldBlockIp(r.address, allowPrivate)) {
        return { error: 'blocked host (resolved private)' };
      }
    }
  } catch {
    // DNS 失败时仍按 hostname 规则；lookup 失败留给后续 fetch
  }
  return null;
}

async function searchDuckDuckGo(query, maxResults = 8, allowPrivate = false) {
  const q = String(query || '').trim();
  if (!q) return { results: [], error: 'empty query' };
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    return { results: [], error: `search HTTP ${res.status}` };
  }
  const html = await res.text();
  const results = [];
  const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && results.length < maxResults) {
    const href = unwrapDdgHref(decodeBasicEntities(m[1]));
    const title = stripTags(m[2]).slice(0, 200);
    if (!href.startsWith('http') || !title) continue;
    try {
      if (shouldBlockHost(new URL(href).hostname, allowPrivate)) continue;
    } catch {
      continue;
    }
    results.push({ title, url: href });
  }
  if (results.length) {
    const snipRe =
      /<a[^>]*class="[^"]*result__a[^"]*"[^>]*>[\s\S]*?<\/a>[\s\S]*?(?:class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td|div)>)/gi;
    let i = 0;
    let sm;
    while ((sm = snipRe.exec(html)) && i < results.length) {
      results[i].snippet = stripTags(sm[1]).slice(0, 280);
      i++;
    }
  }
  return { results, provider: 'duckduckgo-html' };
}

/**
 * @param {string} rawUrl
 * @param {boolean} allowPrivate
 */
export async function fetchPage(rawUrl, allowPrivate = false) {
  let current;
  try {
    current = new URL(String(rawUrl || '').trim());
  } catch {
    return { error: 'invalid url' };
  }

  let lastStatus = 0;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const blocked = await assertSafeDestination(current, allowPrivate);
    if (blocked) return blocked;

    const res = await fetch(current.toString(), {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(25000),
    });
    lastStatus = res.status;

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc)
        return { error: 'redirect without location', status: res.status, url: current.toString() };
      try {
        current = new URL(loc, current);
      } catch {
        return { error: 'invalid redirect location', status: res.status, url: current.toString() };
      }
      // drain body
      try {
        await res.arrayBuffer();
      } catch {
        // ignore
      }
      continue;
    }

    const ctype = (res.headers.get('content-type') || '').toLowerCase();
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_FETCH) {
      return {
        error: `response too large (>${MAX_FETCH} bytes)`,
        status: res.status,
        url: current.toString(),
      };
    }
    const raw = buf.toString('utf8');
    let title = '';
    const tm = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (tm) title = stripTags(tm[1]).slice(0, 200);
    let text = raw;
    if (ctype.includes('html') || /<html[\s>]/i.test(raw)) {
      text = stripTags(raw);
    }
    if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT)}\n…(truncated)`;
    return {
      ok: true,
      status: res.status,
      url: current.toString(),
      contentType: ctype,
      title,
      text,
    };
  }
  return { error: 'too many redirects', status: lastStatus, url: current.toString() };
}

/**
 * @returns {import('vite').Plugin}
 */
export function lhWebPlugin() {
  return {
    name: 'lh-web',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url?.split('?')[0] ?? '';
        if (!url.startsWith(PREFIX)) return next();

        try {
          if (url === `${PREFIX}/health` && req.method === 'GET') {
            return sendJson(res, 200, { ok: true, mode: 'proxy', search: 'duckduckgo-html' });
          }

          if (url === `${PREFIX}/search` && req.method === 'POST') {
            const body = JSON.parse((await readBody(req)) || '{}');
            const maxResults = Math.min(12, Math.max(1, Number(body.maxResults) || 8));
            const allowPrivate = body.allowPrivate === true;
            const data = await searchDuckDuckGo(body.query, maxResults, allowPrivate);
            return sendJson(res, data.error && !data.results?.length ? 502 : 200, data);
          }

          if (url === `${PREFIX}/fetch` && req.method === 'POST') {
            const body = JSON.parse((await readBody(req)) || '{}');
            const allowPrivate = body.allowPrivate === true;
            const data = await fetchPage(body.url, allowPrivate);
            return sendJson(res, data.error && !data.ok ? 400 : 200, data);
          }

          return sendJson(res, 404, { error: 'not found' });
        } catch (e) {
          return sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
        }
      });
    },
  };
}

export {
  shouldBlockHost,
  shouldBlockIp,
  isPrivateHostname,
  isPrivateIp,
} from './web-fetch-policy.mjs';

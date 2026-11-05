/**
 * 工作台本地附件解析：旧版 Word（.doc）等需 Node 侧抽正文。
 * POST /__tb_attach/text?name=xxx.doc  body=原始字节 → { ok, name, content }
 */
import WordExtractorMod from 'word-extractor';

const WordExtractor = WordExtractorMod?.default ?? WordExtractorMod;

const PREFIX = '/__tb_attach';
const MAX_BYTES = 10 * 1024 * 1024;

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

async function readBody(req, limit) {
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > limit) {
      const err = new Error(`文件超过 ${Math.round(limit / 1024 / 1024)} MB`);
      err.code = 'TOO_LARGE';
      throw err;
    }
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

function extOf(name) {
  const i = String(name ?? '').lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

/**
 * @param {Buffer} buf
 * @param {string} name
 */
export async function extractAttachText(buf, name) {
  const ext = extOf(name);
  if (ext !== 'doc' && ext !== 'docx') {
    throw new Error(`暂不支持服务端解析 .${ext || '?'}`);
  }
  const extractor = new WordExtractor();
  const doc = await extractor.extract(buf);
  const body = String(doc.getBody?.() ?? '').trim();
  const parts = [`# ${name}`, '', body || '（未提取到正文）'];
  return parts.join('\n');
}

/**
 * @returns {import('vite').Plugin}
 */
export function lhAttachPlugin() {
  return {
    name: 'lh-attach',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url?.split('?')[0] ?? '';
        if (!url.startsWith(PREFIX)) return next();
        try {
          if (url === `${PREFIX}/health` && req.method === 'GET') {
            return sendJson(res, 200, { ok: true });
          }
          if (url === `${PREFIX}/text` && req.method === 'POST') {
            const u = new URL(req.url || '', 'http://local');
            const name =
              String(u.searchParams.get('name') || 'attachment.doc').trim() || 'attachment.doc';
            let buf;
            try {
              buf = await readBody(req, MAX_BYTES);
            } catch (e) {
              if (e && e.code === 'TOO_LARGE') {
                return sendJson(res, 413, { ok: false, error: e.message });
              }
              throw e;
            }
            if (!buf.length) {
              return sendJson(res, 400, { ok: false, error: '空文件' });
            }
            try {
              const content = await extractAttachText(buf, name);
              return sendJson(res, 200, { ok: true, name, content, size: buf.length });
            } catch (e) {
              return sendJson(res, 422, {
                ok: false,
                error: e instanceof Error ? e.message : String(e),
              });
            }
          }
          return sendJson(res, 404, { error: 'not found' });
        } catch (e) {
          return sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
        }
      });
    },
  };
}

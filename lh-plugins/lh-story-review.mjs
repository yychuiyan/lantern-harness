/**
 * 「用户故事审查」提示词中间件。
 *
 * 本插件不存自己的数据：审查结果写回 `需求分析/需求分析.json` 的 `check` 字段，
 * 这里只负责两件事——探测服务是否就绪、把插件提示词同步进「提示词管理」并读出两段正文。
 *
 * 路由：`/__tb_storyreview?health=1`、`GET /__tb_storyreview/prompt`、`POST /__tb_storyreview/prompt/sync`
 */
import { getDataRoot } from '../builtin/session/space-context.mjs';
import { ensurePluginPrompt, isPluginOnInSpace, readPluginPrompt } from './plugin-prompts.mjs';
import {
  STORY_REVIEW_PROMPT_FILE,
  STORY_REVIEW_PROMPT_TEMPLATE,
  parseStoryReviewPromptSections,
} from './story-review-prompt.mjs';

const PREFIX = '/__tb_storyreview';
const VERSION = 1;

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * @returns {import('vite').Plugin}
 */
export function lhStoryReviewPlugin() {
  return {
    name: 'lh-story-review',
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
            return sendJson(res, 200, { ok: true, files: {}, version: VERSION });
          }

          if (method === 'GET' && tail === '/prompt') {
            // 插件还开着但文件被删（外部删除 / 换空间）时自动补种子
            if (isPluginOnInSpace('storyReview', root)) {
              ensurePluginPrompt(STORY_REVIEW_PROMPT_FILE, STORY_REVIEW_PROMPT_TEMPLATE, root);
            }
            const content = readPluginPrompt(STORY_REVIEW_PROMPT_FILE, root);
            const sections = parseStoryReviewPromptSections(content);
            return sendJson(res, 200, {
              ok: true,
              file: STORY_REVIEW_PROMPT_FILE,
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
                exists: Boolean(readPluginPrompt(STORY_REVIEW_PROMPT_FILE, root).trim()),
                file: STORY_REVIEW_PROMPT_FILE,
              });
            }
            const out = ensurePluginPrompt(
              STORY_REVIEW_PROMPT_FILE,
              STORY_REVIEW_PROMPT_TEMPLATE,
              root,
            );
            return sendJson(res, 200, { ok: true, enabled: true, ...out });
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

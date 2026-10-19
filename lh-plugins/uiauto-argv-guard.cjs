/**
 * 预加载守卫（`NODE_OPTIONS=--require`）：给 Playwright 的 `--project` 参数让路。
 *
 * 有些项目的 playwright.config 会 `import 'tsconfig-paths/register'`；这个包在注册时会用
 * minimist 解析 `process.argv` 的 `--project/-P`，把项目名当成 tsconfig 路径，
 * 直接 `ENOENT: stat 'chromium-admin'` 崩掉（Playwright 自己其实解析得很好）。
 *
 * 这里只在加载 tsconfig-paths 注册器的那一瞬间把那两个参数从 argv 里摘掉，加载完立刻还原，
 * 不影响 Playwright 自己读参数。
 */
'use strict';

const Module = require('module');
const originalLoad = Module._load;

function stripProjectFlag(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i]);
    if (arg === '--project' || arg === '-P') {
      i += 1;
      continue;
    }
    if (arg.startsWith('--project=')) continue;
    out.push(argv[i]);
  }
  return out;
}

Module._load = function load(request, parent, isMain) {
  if (typeof request === 'string' && /(^|[\\/])tsconfig-paths[\\/]register(\.js)?$/.test(request)) {
    const saved = process.argv.slice();
    process.argv = stripProjectFlag(process.argv);
    try {
      return originalLoad.call(this, request, parent, isMain);
    } finally {
      process.argv = saved;
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};

/**
 * 项目内 auth.setup / Playwright setup 工程：探测 + 无头跑一遍产出 storageState。
 * 登录墙自动链在 SSO 不可用或失败时回落走这里；不扫任意业务 *login*.spec。
 *
 * 跑 setup 时会把项目 .env 注入子进程，并把 LOGIN_API_URL 等别名回填为
 * LOGIN_API_PATH，避免项目里的 tryApiLogin 只认 PATH 而空跑。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { resolvePackageManager } from './uiauto-pm.mjs';
import { withProjectNode } from './uiauto-node.mjs';
import { detectStorageState, findPlaywrightConfig } from './uiauto-explorer/sessions.mjs';
import { readProjectEnvMap, resolveLoginApiEndpoint } from './uiauto-sso.mjs';

const AUTH_SETUP_FILES = [
  'tests/auth.setup.ts',
  'tests/auth.setup.js',
  'auth.setup.ts',
  'auth.setup.js',
];

const SETUP_TIMEOUT_MS = 120_000;

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function existsFile(root, rel) {
  try {
    return fs.statSync(path.join(root, rel)).isFile();
  } catch {
    return false;
  }
}

/** playwright.config 里是否声明了 name: 'setup' / "setup" 的 project */
export function playwrightHasSetupProject(dir) {
  const root = String(dir || '');
  if (!root) return false;
  const configName = findPlaywrightConfig(root);
  if (!configName) return false;
  const content = readText(path.join(root, configName));
  if (!content) return false;
  // name: 'setup' | name: "setup" | name: `setup`
  return /\bname\s*:\s*(['"`])setup\1/.test(content);
}

/** 命中的 auth.setup 相对路径；没有则空串 */
export function findAuthSetupFile(dir) {
  const root = String(dir || '');
  if (!root) return '';
  for (const rel of AUTH_SETUP_FILES) {
    if (existsFile(root, rel)) return rel.replace(/\\/g, '/');
  }
  // 挂载项目常见 tests/auth-unit.setup.ts、tests/xxx.auth.setup.ts
  try {
    const names = fs.readdirSync(path.join(root, 'tests'));
    const hit = names
      .filter((name) => /\.setup\.(ts|js|mjs|cjs)$/i.test(name) && /auth/i.test(name))
      .sort();
    if (hit.length) return path.posix.join('tests', hit[0]);
  } catch {
    // no tests/
  }
  return '';
}

/**
 * 项目是否具备可跑的登录态 setup（文件或 setup 工程）。
 */
export function projectHasAuthSetup(dir) {
  const root = String(dir || '');
  if (!root || !fs.existsSync(root)) return false;
  return Boolean(findAuthSetupFile(root) || playwrightHasSetupProject(root));
}

/**
 * 决定怎么调 Playwright：优先 --project=setup，否则跑 auth.setup 文件。
 * @returns {{ mode: 'project'|'file', target: string, command: string } | null}
 */
export function resolveAuthSetupCommand(dir) {
  const root = String(dir || '');
  if (!root) return null;
  const { commands } = resolvePackageManager({ dir: root });
  const hasProject = playwrightHasSetupProject(root);
  const file = findAuthSetupFile(root);
  if (hasProject) {
    return {
      mode: 'project',
      target: 'setup',
      command: commands.exec('playwright', ['test', '--project=setup']),
    };
  }
  if (file) {
    return {
      mode: 'file',
      target: file,
      command: commands.exec('playwright', ['test', file]),
    };
  }
  return null;
}

function runShell(command, cwd, env, timeoutMs) {
  return new Promise((resolve) => {
    let output = '';
    let done = false;
    const finish = (code, extra = '') => {
      if (done) return;
      done = true;
      resolve({ code, output: `${output}${extra}`.slice(-20_000) });
    };
    let child;
    try {
      child = spawn(command, {
        cwd,
        shell: true,
        env: { ...env, FORCE_COLOR: '0', CI: '1' },
      });
    } catch (error) {
      finish(
        -1,
        `\n[lantern] 启动失败：${error instanceof Error ? error.message : String(error)}\n`,
      );
      return;
    }
    const push = (chunk) => {
      output += String(chunk);
      if (output.length > 40_000) output = output.slice(-20_000);
    };
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', push);
    child.stderr?.on('data', push);
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      finish(-1, `\n[lantern] auth.setup 超过 ${Math.round(timeoutMs / 1000)} 秒，已终止。\n`);
    }, timeoutMs);
    timer.unref?.();
    child.on('error', (error) => {
      clearTimeout(timer);
      finish(-1, `\n[lantern] ${error instanceof Error ? error.message : String(error)}\n`);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish(typeof code === 'number' ? code : -1);
    });
  });
}

/**
 * 无头跑 auth.setup，成功后探测 storageState。
 * @returns {{ ok: true, storageState: string, command: string, output: string } | { ok: false, error: string, output?: string }}
 */
export async function runAuthSetupAndSave({ dir, envName = '' }) {
  const root = String(dir || '');
  if (!root || !fs.existsSync(root)) {
    return { ok: false, error: '项目目录不存在' };
  }
  const plan = resolveAuthSetupCommand(root);
  if (!plan) {
    return { ok: false, error: '未检测到 auth.setup 文件或 Playwright setup 工程' };
  }

  const projectEnv = readProjectEnvMap(root, envName);
  const endpoint = resolveLoginApiEndpoint(projectEnv);
  // 项目代码多半只读 LOGIN_API_PATH：把 URL 等别名回填进去
  const aliasPath =
    endpoint.value && !String(projectEnv.LOGIN_API_PATH || '').trim()
      ? { LOGIN_API_PATH: endpoint.value }
      : {};
  const env = withProjectNode(
    {
      ...process.env,
      ...projectEnv,
      ...aliasPath,
      ...(envName ? { ENV: String(envName) } : {}),
      CI: '1',
    },
    root,
  );
  const { code, output } = await runShell(plan.command, root, env, SETUP_TIMEOUT_MS);
  if (code !== 0) {
    const tail = String(output || '')
      .trim()
      .slice(-500);
    return {
      ok: false,
      error: `auth.setup 未成功（exit ${code}）${tail ? `：${tail}` : ''}`,
      output,
    };
  }

  const storageState = detectStorageState(root);
  if (!storageState) {
    const text = String(output || '');
    const skipped = /\bskipped\b|\b跳过\b|未配置.*账号/i.test(text);
    const hint = skipped
      ? '用例可能被 skip（检查 ADMIN_USERNAME / ADMIN_PASSWORD）。'
      : '若 setup 走 UI 登录且有验证码，无头跑会写不出登录态。';
    return {
      ok: false,
      error: `auth.setup 已执行（${plan.command}），但项目里仍未找到 .auth / storageState 文件。${hint}`,
      output,
    };
  }
  return { ok: true, storageState, command: plan.command, output };
}

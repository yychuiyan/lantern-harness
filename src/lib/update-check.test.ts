/**
 * 版本检测核心逻辑的单元测试：
 * - 版本比较边界（`0.1.9 < 0.1.10`、预发布、`v` 前缀）
 * - 安装方式识别（npx 缓存 / 全局 node_modules / 源码仓库）
 * - 更新状态文件的缺失、损坏与「中断」容错
 *
 * 状态文件测试把 XDG_CONFIG_HOME 指到临时目录，绝不碰真实用户配置。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  __resetUpdateCheckCache,
  compareVersions,
  detectInstallMode,
  getUpdateStatusPath,
  hasUpdate,
  parseHttpJson,
  proxyEnv,
  readUpdateStatus,
  resolveProxyUrl,
  STATUS_STALE_MS,
  writeUpdateStatus,
} from '../../builtin/session/update-check.mjs';

const ORIGINAL_XDG = process.env.XDG_CONFIG_HOME;
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-update-test-'));
process.env.XDG_CONFIG_HOME = tempHome;

after(() => {
  if (ORIGINAL_XDG === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = ORIGINAL_XDG;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

describe('compareVersions', () => {
  it('按数字段比较，而不是字符串', () => {
    assert.equal(compareVersions('0.1.9', '0.1.10'), -1);
    assert.equal(compareVersions('0.1.10', '0.1.9'), 1);
    assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  });

  it('相等与补齐段位', () => {
    assert.equal(compareVersions('0.1.6', '0.1.6'), 0);
    assert.equal(compareVersions('0.1', '0.1.0'), 0);
    assert.equal(compareVersions('v1.2.3', '1.2.3'), 0);
    assert.equal(compareVersions('V1.2.4', '1.2.3'), 1);
  });

  it('预发布小于同段正式版', () => {
    assert.equal(compareVersions('1.0.0-beta.1', '1.0.0'), -1);
    assert.equal(compareVersions('1.0.0', '1.0.0-rc.1'), 1);
    assert.equal(compareVersions('1.0.0-beta', '1.0.0-beta'), 0);
  });

  it('空值按 0 处理，不抛错', () => {
    assert.equal(compareVersions('', '0.0.0'), 0);
    assert.equal(compareVersions(undefined, '0.0.0'), 0);
  });
});

describe('hasUpdate', () => {
  it('只有远端更高才算有更新', () => {
    assert.equal(hasUpdate('0.1.7', '0.1.6'), true);
    assert.equal(hasUpdate('0.1.6', '0.1.6'), false);
    assert.equal(hasUpdate('0.1.5', '0.1.6'), false);
  });

  it('缺一边或检查失败时不算更新', () => {
    assert.equal(hasUpdate('', '0.1.6'), false);
    assert.equal(hasUpdate('0.1.7', ''), false);
  });
});

describe('detectInstallMode', () => {
  const globalRoot = path.join(path.sep, 'usr', 'lib', 'node_modules');

  it('npx 临时缓存', () => {
    const pkg = path.join(
      path.sep,
      'home',
      'me',
      '.npm',
      '_npx',
      'abc123',
      'node_modules',
      'lantern-harness',
    );
    assert.equal(detectInstallMode(pkg, 'npm', globalRoot), 'npx');
  });

  it('全局 node_modules 下', () => {
    assert.equal(
      detectInstallMode(path.join(globalRoot, 'lantern-harness'), 'npm', globalRoot),
      'global',
    );
  });

  it('仓库源码目录', () => {
    assert.equal(detectInstallMode('/Volumes/code/lantern-harness', 'npm', globalRoot), 'dev');
  });

  it('同名目录但不在全局根下不算全局安装', () => {
    assert.equal(
      detectInstallMode('/project/node_modules/lantern-harness', 'npm', globalRoot),
      'dev',
    );
  });

  it('解析不到全局根时按源码处理', () => {
    assert.equal(detectInstallMode('/project/node_modules/lantern-harness', 'npm', ''), 'dev');
  });
});

describe('代理探测', () => {
  const KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];
  const saved = new Map(KEYS.map((k) => [k, process.env[k]]));
  const restore = () => {
    for (const k of KEYS) {
      if (saved.get(k) === undefined) delete process.env[k];
      else process.env[k] = saved.get(k) as string;
    }
    __resetUpdateCheckCache();
  };

  it('优先读 HTTPS_PROXY；socks 不支持时退回直连', () => {
    for (const k of KEYS) delete process.env[k];
    __resetUpdateCheckCache();
    process.env.HTTPS_PROXY = 'http://127.0.0.1:7890';
    assert.equal(resolveProxyUrl(), 'http://127.0.0.1:7890');
    // HTTPS_PROXY 已有就不再覆盖，但还会补一份 HTTP_PROXY 给 npm 用
    assert.deepEqual(proxyEnv(), {
      HTTP_PROXY: 'http://127.0.0.1:7890',
      http_proxy: 'http://127.0.0.1:7890',
    });

    __resetUpdateCheckCache();
    process.env.HTTPS_PROXY = 'socks5://127.0.0.1:1080';
    assert.equal(resolveProxyUrl(), '');
    assert.deepEqual(proxyEnv(), {});
    restore();
  });

  it('只配了 ALL_PROXY 时给 npm 子进程补 HTTP(S)_PROXY', () => {
    for (const k of KEYS) delete process.env[k];
    __resetUpdateCheckCache();
    process.env.ALL_PROXY = 'http://127.0.0.1:1082';
    assert.equal(resolveProxyUrl(), 'http://127.0.0.1:1082');
    assert.deepEqual(proxyEnv(), {
      HTTPS_PROXY: 'http://127.0.0.1:1082',
      HTTP_PROXY: 'http://127.0.0.1:1082',
      http_proxy: 'http://127.0.0.1:1082',
    });
    restore();
  });
});

describe('代理隧道响应解析', () => {
  it('Content-Length 响应', () => {
    const raw = Buffer.from(
      'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"version":"0.1.7"}',
    );
    assert.deepEqual(parseHttpJson(raw), { version: '0.1.7' });
  });

  it('chunked 响应', () => {
    const raw = Buffer.from(
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n' +
        '7\r\n{"versi\r\n' +
        'c\r\non":"0.1.8"}\r\n' +
        '0\r\n\r\n',
    );
    assert.deepEqual(parseHttpJson(raw), { version: '0.1.8' });
  });

  it('4xx / 非 JSON 报错', () => {
    assert.throws(() => parseHttpJson(Buffer.from('HTTP/1.1 404 Not Found\r\n\r\n{}')), /HTTP 404/);
    assert.throws(() => parseHttpJson(Buffer.from('HTTP/1.1 200 OK\r\n\r\n<html>')), /JSON/);
  });
});

describe('更新状态文件', () => {
  it('文件缺失返回 null', () => {
    fs.rmSync(getUpdateStatusPath(), { force: true });
    assert.equal(readUpdateStatus(), null);
  });

  it('损坏的 JSON 返回 null 而不是抛错', () => {
    const file = getUpdateStatusPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ not json', 'utf8');
    assert.equal(readUpdateStatus(), null);
  });

  it('写入后可读回，done 带结束时间', () => {
    writeUpdateStatus({ phase: 'installing', from: '0.1.6', to: '0.1.7' });
    const started = readUpdateStatus();
    assert.equal(started?.phase, 'installing');
    assert.equal(started?.from, '0.1.6');
    assert.equal(started?.to, '0.1.7');
    assert.ok(started?.startedAt);

    writeUpdateStatus({ phase: 'done' });
    const done = readUpdateStatus();
    assert.equal(done?.phase, 'done');
    assert.ok(done?.finishedAt);
    assert.equal(done?.from, '0.1.6');
  });

  it('失败的 error 会被保留', () => {
    writeUpdateStatus({ phase: 'failed', error: '全局安装失败' });
    assert.equal(readUpdateStatus()?.error, '全局安装失败');
  });

  it('长时间停在 installing 视为上次中断', () => {
    const stale = new Date(Date.now() - STATUS_STALE_MS - 60_000).toISOString();
    fs.writeFileSync(
      getUpdateStatusPath(),
      JSON.stringify({ phase: 'installing', from: '0.1.6', startedAt: stale }),
      'utf8',
    );
    const status = readUpdateStatus();
    assert.equal(status?.phase, 'failed');
    assert.match(status?.error ?? '', /未完成/);
  });
});

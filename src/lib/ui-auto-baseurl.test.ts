/**
 * 生成页「起始地址」与「提示词选择」的回归测试。
 *
 * 两个都是按项目落盘的配置：
 * 1. 地址：项目自己的 playwright 配置 / .env 里写了什么就读什么（含 /admin 这类路径后缀），
 *    读不到才由用户手填，填一次记住；
 * 2. 提示词：不同框架可以挂不同 .md，只接受提示词目录里的文件名，挡住路径穿越。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { isPromptFileName } from '../../lh-plugins/lh-uiauto.mjs';
import { detectBaseURL, detectStorageState } from '../../lh-plugins/uiauto-explorer/sessions.mjs';

let tmp = '';

function write(dir: string, name: string, body: string) {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-baseurl-'));
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('detectBaseURL', () => {
  it('读 playwright 配置里 use.baseURL 的字面量兜底值', () => {
    const dir = path.join(tmp, 'cfg');
    write(
      dir,
      'playwright.config.ts',
      [
        "import { defineConfig } from '@playwright/test';",
        'export default defineConfig({',
        '  use: {',
        "    baseURL: process.env.BASE_URL || 'http://localhost:5173/admin',",
        '  },',
        '});',
      ].join('\n'),
    );
    assert.equal(detectBaseURL(dir), 'http://localhost:5173/admin');
  });

  it('配置里没有 baseURL 时退回 .env 的 BASE_URL', () => {
    const dir = path.join(tmp, 'env');
    write(dir, 'playwright.config.ts', 'export default {};\n');
    write(dir, '.env', '# 开发环境\nBASE_URL=http://localhost:8080/app\n');
    assert.equal(detectBaseURL(dir), 'http://localhost:8080/app');
  });

  it('.env 里注释掉的行不算', () => {
    const dir = path.join(tmp, 'commented');
    write(dir, '.env', '# BASE_URL=http://old\nBASE_URL=http://localhost:9000\n');
    assert.equal(detectBaseURL(dir), 'http://localhost:9000');
  });

  it('什么都没有时返回空串，交给用户手填', () => {
    const dir = path.join(tmp, 'empty');
    fs.mkdirSync(dir, { recursive: true });
    write(dir, 'package.json', '{"name":"x"}');
    assert.equal(detectBaseURL(dir), '');
  });
});

describe('detectStorageState', () => {
  it('优先读 playwright 配置里写死的 storageState', () => {
    const dir = path.join(tmp, 'auth-cfg');
    write(
      dir,
      'playwright.config.ts',
      ['export default {', "  use: { storageState: '.auth/login-state.json' },", '};'].join('\n'),
    );
    write(dir, '.auth/login-state.json', '{}');
    // 同一目录下还有约定命名的文件，配置里写死的优先
    write(dir, 'auth.json', '{}');
    assert.equal(detectStorageState(dir), '.auth/login-state.json');
  });

  it('没有配置时按约定命名找（项目根 / .auth / tests / fixtures）', () => {
    const root = path.join(tmp, 'auth-root');
    write(root, 'auth-admin.json', '{}');
    assert.equal(detectStorageState(root), 'auth-admin.json');

    const nested = path.join(tmp, 'auth-nested');
    write(nested, 'tests/fixtures/storage-state.json', '{}');
    assert.equal(detectStorageState(nested), 'tests/fixtures/storage-state.json');
  });

  it('项目自己命名的文件也能从 .auth 里认出来', () => {
    const dir = path.join(tmp, 'auth-custom');
    write(dir, '.auth/admin-2026.json', '{}');
    assert.equal(detectStorageState(dir), '.auth/admin-2026.json');
  });

  it('一个都没有时返回空串（按未登录身份跑）', () => {
    const dir = path.join(tmp, 'auth-none');
    write(dir, 'package.json', '{"name":"x"}');
    assert.equal(detectStorageState(dir), '');
  });
});

describe('isPromptFileName', () => {
  it('接受提示词目录里的 .md（含分组目录）', () => {
    assert.equal(isPromptFileName('Playwright提示词.md'), true);
    assert.equal(isPromptFileName('前端/Playwright 提示词.md'), true);
  });

  it('挡住路径穿越与绝对路径', () => {
    assert.equal(isPromptFileName('../../etc/passwd'), false);
    assert.equal(isPromptFileName('/tmp/x.md'), false);
    assert.equal(isPromptFileName('..\\win.md'), false);
  });

  it('非 markdown 不收', () => {
    assert.equal(isPromptFileName('config.json'), false);
    assert.equal(isPromptFileName(''), false);
  });
});

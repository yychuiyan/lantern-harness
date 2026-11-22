import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  findAuthSetupFile,
  playwrightHasSetupProject,
  projectHasAuthSetup,
  resolveAuthSetupCommand,
} from '../../lh-plugins/uiauto-auth-setup.mjs';

describe('uiauto-auth-setup 探测', () => {
  let root = '';

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-auth-setup-'));
  });

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('无文件无 setup 工程 → 未检测到', () => {
    assert.equal(projectHasAuthSetup(root), false);
    assert.equal(findAuthSetupFile(root), '');
    assert.equal(resolveAuthSetupCommand(root), null);
  });

  it('有 tests/auth.setup.ts → 按文件跑', () => {
    fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tests', 'auth.setup.ts'), 'export {};\n');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'demo' }));
    assert.equal(projectHasAuthSetup(root), true);
    assert.equal(findAuthSetupFile(root), 'tests/auth.setup.ts');
    const cmd = resolveAuthSetupCommand(root);
    assert.ok(cmd);
    assert.equal(cmd.mode, 'file');
    assert.match(cmd.command, /playwright.*tests\/auth\.setup\.ts/);
  });

  it('认 tests/auth-unit.setup.ts 这类命名', () => {
    fs.rmSync(path.join(root, 'tests', 'auth.setup.ts'), { force: true });
    fs.writeFileSync(path.join(root, 'tests', 'auth-unit.setup.ts'), 'export {};\n');
    assert.equal(findAuthSetupFile(root), 'tests/auth-unit.setup.ts');
    assert.equal(projectHasAuthSetup(root), true);
  });

  it('config 声明 setup 工程时优先 --project=setup', () => {
    fs.writeFileSync(
      path.join(root, 'playwright.config.ts'),
      `export default { projects: [{ name: 'setup', testMatch: /auth\\.setup\\.ts/ }] };\n`,
    );
    assert.equal(playwrightHasSetupProject(root), true);
    const cmd = resolveAuthSetupCommand(root);
    assert.ok(cmd);
    assert.equal(cmd.mode, 'project');
    assert.match(cmd.command, /--project=setup/);
  });
});

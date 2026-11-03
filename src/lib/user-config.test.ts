/**
 * 本机配置目录命名：与 GitHub 仓库一致用 lantern-harness，
 * 旧安装的 ai-testbench 目录只读兼容（首次访问复制过来，原目录保留）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

const prevXdg = process.env.XDG_CONFIG_HOME;

afterEach(() => {
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
});

describe('user-config 配置目录', () => {
  it('旧目录 ai-testbench 首次访问复制到 lantern-harness，原目录保留', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-user-config-'));
    const legacy = path.join(home, 'ai-testbench');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'spaces.json'), '{"activeId":"public"}', 'utf8');
    fs.writeFileSync(path.join(legacy, 'models.json'), '{"providers":[]}', 'utf8');
    process.env.XDG_CONFIG_HOME = home;

    const { USER_CONFIG_DIR_NAME, getConfigPath, getUserConfigDir } =
      await import('../../cli/user-config.mjs');

    const dir = getUserConfigDir();
    assert.equal(USER_CONFIG_DIR_NAME, 'lantern-harness');
    assert.equal(path.basename(dir), 'lantern-harness');
    assert.equal(fs.existsSync(dir), true);
    assert.equal(fs.readFileSync(path.join(dir, 'spaces.json'), 'utf8'), '{"activeId":"public"}');
    assert.equal(fs.readFileSync(path.join(dir, 'models.json'), 'utf8'), '{"providers":[]}');
    assert.equal(getConfigPath(), path.join(dir, 'config.json'));
    assert.equal(fs.existsSync(path.join(legacy, 'spaces.json')), true, '旧目录保留作备份，不删除');
  });
});

describe('user-config 双池根', () => {
  it('scope both 写入 dataRoot 与 devDataRoot；dev 优先读自己的', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-dual-root-'));
    process.env.XDG_CONFIG_HOME = home;
    const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-web-root-'));
    const devRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-dev-root-'));

    const { normalizeDataRootScope, resolveRuntimeSpacesRoot, saveDataRootForScope } =
      await import('../../cli/user-config.mjs');

    assert.equal(normalizeDataRootScope('3'), 'both');
    assert.equal(normalizeDataRootScope('web'), 'web');

    saveDataRootForScope(webRoot, 'both');
    let web = resolveRuntimeSpacesRoot({ role: 'web' });
    let dev = resolveRuntimeSpacesRoot({ role: 'dev' });
    assert.equal(web.ok, true);
    assert.equal(dev.ok, true);
    if (web.ok) assert.equal(web.dataRoot, path.resolve(webRoot));
    if (dev.ok) assert.equal(dev.dataRoot, path.resolve(webRoot));

    saveDataRootForScope(devRoot, 'dev');
    web = resolveRuntimeSpacesRoot({ role: 'web' });
    dev = resolveRuntimeSpacesRoot({ role: 'dev' });
    assert.equal(web.ok, true);
    assert.equal(dev.ok, true);
    if (web.ok) assert.equal(web.dataRoot, path.resolve(webRoot));
    if (dev.ok) {
      assert.equal(dev.dataRoot, path.resolve(devRoot));
      assert.equal(dev.source, 'devDataRoot');
    }
  });

  it('开发未配置时回退 dataRoot，再回退 fallback', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-dev-fallback-'));
    process.env.XDG_CONFIG_HOME = home;
    const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-web-only-'));
    const fallback = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-fb-'));

    const { resolveRuntimeSpacesRoot, saveDataRootForScope } =
      await import('../../cli/user-config.mjs');

    saveDataRootForScope(webRoot, 'web');
    const viaWeb = resolveRuntimeSpacesRoot({ role: 'dev' });
    assert.equal(viaWeb.ok, true);
    if (viaWeb.ok) {
      assert.equal(viaWeb.dataRoot, path.resolve(webRoot));
      assert.equal(viaWeb.source, 'dataRoot');
    }

    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-empty-cfg-'));
    process.env.XDG_CONFIG_HOME = emptyHome;
    const viaFb = resolveRuntimeSpacesRoot({ role: 'dev', fallback });
    assert.equal(viaFb.ok, true);
    if (viaFb.ok) {
      assert.equal(viaFb.dataRoot, path.resolve(fallback));
      assert.equal(viaFb.source, 'fallback');
    }
  });
});

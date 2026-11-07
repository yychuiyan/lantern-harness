import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  concreteNodeVersion,
  listNodeInstallations,
  nodeInstallPlan,
  nodeStatus,
  parseNodeVersion,
  readNodeRequirement,
  satisfiesNode,
  withProjectNode,
  writeNvmrc,
} from '../../lh-plugins/uiauto-node.mjs';
import {
  nodeManualHint,
  nodeInstallTarget,
  nodeRunWarning,
  type ProjectNodeStatus,
} from './ui-auto-node';

describe('parseNodeVersion', () => {
  it('认 v 前缀、两段、预发布后缀', () => {
    assert.deepEqual(parseNodeVersion('v22.23.0'), [22, 23, 0]);
    assert.deepEqual(parseNodeVersion('20'), [20, 0, 0]);
    assert.deepEqual(parseNodeVersion('22.23'), [22, 23, 0]);
    assert.deepEqual(parseNodeVersion('22.23.0-linux-x64'), [22, 23, 0]);
    assert.equal(parseNodeVersion('lts/*'), null);
  });
});

describe('satisfiesNode', () => {
  it('精确与前缀', () => {
    assert.equal(satisfiesNode('22.23.0', '22.23.0'), true);
    assert.equal(satisfiesNode('22.23.1', '22.23.0'), false);
    assert.equal(satisfiesNode('22.23.0', '22'), true);
    assert.equal(satisfiesNode('20.11.1', '22'), false);
    assert.equal(satisfiesNode('22.23.0', '22.23'), true);
  });

  it('范围、多段、^ 与 ~', () => {
    assert.equal(satisfiesNode('22.23.0', '>=22.23.0'), true);
    assert.equal(satisfiesNode('22.22.0', '>=22.23.0'), false);
    assert.equal(satisfiesNode('22.23.0', '>=20 <23'), true);
    assert.equal(satisfiesNode('23.0.1', '>=20 <23'), false);
    assert.equal(satisfiesNode('22.30.0', '^22.23.0'), true);
    assert.equal(satisfiesNode('23.0.0', '^22.23.0'), false);
    assert.equal(satisfiesNode('22.23.9', '~22.23.0'), true);
    assert.equal(satisfiesNode('22.24.0', '~22.23.0'), false);
  });

  it('通配与空要求都算满足', () => {
    assert.equal(satisfiesNode('20.0.0', ''), true);
    assert.equal(satisfiesNode('20.0.0', 'lts/*'), true);
    assert.equal(satisfiesNode('20.0.0', 'node'), true);
  });
});

describe('项目 Node：读要求 / 写 .nvmrc / 运行 PATH', () => {
  let root = '';
  let nvmDir = '';
  let previousNvmDir: string | undefined;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-node-'));
    nvmDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-nvm-'));
    previousNvmDir = process.env.NVM_DIR;
    // 造一个已装的 22.23.0
    const bin = path.join(nvmDir, 'versions', 'node', 'v22.23.0', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'node'), '');
    process.env.NVM_DIR = nvmDir;
  });

  after(() => {
    if (previousNvmDir === undefined) delete process.env.NVM_DIR;
    else process.env.NVM_DIR = previousNvmDir;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(nvmDir, { recursive: true, force: true });
  });

  it('.nvmrc 优先于 engines', () => {
    fs.writeFileSync(path.join(root, '.nvmrc'), '22.23.0\n');
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ engines: { node: '>=20' } }),
    );
    assert.deepEqual(readNodeRequirement(root), {
      nvmrc: '22.23.0',
      nodeVersion: '',
      engines: '>=20',
      required: '22.23.0',
    });
  });

  it('没有 .nvmrc 时退回 engines', () => {
    fs.rmSync(path.join(root, '.nvmrc'), { force: true });
    assert.equal(readNodeRequirement(root).required, '>=20');
  });

  it('.node-version 也认（挂载项目的 fnm / asdf 约定）', () => {
    fs.writeFileSync(path.join(root, '.node-version'), '22.23.0\n');
    assert.deepEqual(readNodeRequirement(root), {
      nvmrc: '',
      nodeVersion: '22.23.0',
      engines: '>=20',
      required: '22.23.0',
    });
    // `.nvmrc` 一旦存在就压过 `.node-version`
    fs.writeFileSync(path.join(root, '.nvmrc'), '20.11.1\n');
    assert.equal(readNodeRequirement(root).required, '20.11.1');
    fs.rmSync(path.join(root, '.nvmrc'), { force: true });
    fs.rmSync(path.join(root, '.node-version'), { force: true });
  });

  it('扫到 NVM_DIR 下的版本，并挑满足要求的那个', () => {
    const found = listNodeInstallations().filter((item) => item.manager === 'nvm');
    assert.equal(found[0]?.version, '22.23.0');
    fs.writeFileSync(path.join(root, '.nvmrc'), '22\n');
    const status = nodeStatus(root);
    assert.equal(status.matched?.version, '22.23.0');
    assert.equal(status.required, '22');
    assert.ok(status.installations.length >= 1);
  });

  it('运行 PATH 把项目 Node 排在最前，且不会重复追加', () => {
    const binDir = path.join(nvmDir, 'versions', 'node', 'v22.23.0', 'bin');
    const env = withProjectNode({ PATH: '/usr/bin:/bin' }, root);
    assert.equal(env.PATH.split(path.delimiter)[0], binDir);
    const again = withProjectNode(env, root);
    assert.equal(again.PATH, env.PATH);
  });

  it('写 / 删 .nvmrc，非法版本报错', () => {
    assert.equal(writeNvmrc(root, 'v22.23.0').version, '22.23.0');
    assert.equal(fs.readFileSync(path.join(root, '.nvmrc'), 'utf8'), '22.23.0\n');
    assert.throws(() => writeNvmrc(root, 'latest'));
    writeNvmrc(root, '');
    assert.equal(fs.existsSync(path.join(root, '.nvmrc')), false);
  });
});

describe('装缺失的 Node 版本', () => {
  let home = '';
  let env: NodeJS.ProcessEnv = {};

  before(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-node-install-'));
    fs.mkdirSync(path.join(home, '.nvm'), { recursive: true });
    fs.writeFileSync(path.join(home, '.nvm', 'nvm.sh'), '');
    // PATH 里什么都没有：别让测试机上的 fnm / volta 影响判定
    env = { PATH: '/nonexistent-bin' };
  });

  after(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('只接受具体版本，范围写法给不出来', () => {
    assert.equal(concreteNodeVersion('22.23.0'), '22.23.0');
    assert.equal(concreteNodeVersion('v22'), '22');
    assert.equal(concreteNodeVersion('^22.23.0'), '22.23.0');
    assert.equal(concreteNodeVersion('>=20 <23'), '');
    assert.equal(concreteNodeVersion('lts/*'), '');
  });

  it('有 nvm 就用 nvm（在 bash 里 source 后再装）', () => {
    const plan = nodeInstallPlan('22.23.0', { home, env });
    if ('error' in plan) assert.fail(plan.error);
    assert.equal(plan.manager, 'nvm');
    assert.equal(plan.command, 'nvm install 22.23.0');
    assert.match(plan.args.join(' '), /source .*nvm\.sh.* && nvm install 22\.23\.0/);
  });

  it('没有版本管理器时说清楚，不瞎猜命令', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-no-nvm-'));
    try {
      const plan = nodeInstallPlan('22.23.0', { home: empty, env });
      assert.ok('error' in plan);
      assert.match(plan.error, /nvm \/ fnm \/ volta/);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('范围版本直接拒绝安装', () => {
    const plan = nodeInstallPlan('>=20 <23', { home, env });
    assert.ok('error' in plan);
    assert.match(plan.error, /具体版本号/);
  });
});

describe('面板：手动切换提示按实际管理器写', () => {
  const base: ProjectNodeStatus = {
    nvmrc: '22.23.0',
    nodeVersion: '',
    engines: '>=22.23.0',
    required: '22.23.0',
    running: '20.11.1',
    runningSatisfies: false,
    matched: null,
    installations: [],
    managers: [],
    installers: [],
    error: '',
  };

  it('没声明 .nvmrc 时不给命令也不给提示', () => {
    assert.deepEqual(nodeManualHint({ ...base, nvmrc: '', required: '' }), {
      command: '',
      note: '',
    });
  });

  it('nvm / fnm 给对应命令', () => {
    assert.equal(
      nodeManualHint({
        ...base,
        matched: { manager: 'nvm', version: '22.23.0', binDir: '/n' },
      }).command,
      'nvm use 22.23.0',
    );
    assert.equal(
      nodeManualHint({
        ...base,
        matched: { manager: 'fnm', version: '22.23.0', binDir: '/f' },
      }).command,
      'fnm use 22.23.0',
    );
  });

  it('volta 不读 .nvmrc，改成 volta pin', () => {
    const hint = nodeManualHint({
      ...base,
      matched: { manager: 'volta', version: '22.23.0', binDir: '/v' },
    });
    assert.equal(hint.command, '');
    assert.match(hint.note, /volta pin node@22\.23\.0/);
  });

  it('没装任何版本管理器时不说「执行 nvm use」', () => {
    const hint = nodeManualHint({ ...base, installers: [] });
    assert.equal(hint.command, '');
    assert.match(hint.note, /本机没装 nvm \/ fnm \/ volta/);
    assert.doesNotMatch(hint.note, /nvm use/);
  });

  it('装了管理器但还没有满足要求的版本：说明可点上面安装', () => {
    const hint = nodeManualHint({ ...base, installers: ['nvm'] });
    assert.equal(hint.command, '');
    assert.match(hint.note, /已装 nvm/);
  });
});

describe('运行前：Node 版本不一致的提醒', () => {
  const base: ProjectNodeStatus = {
    nvmrc: '24.9.0',
    nodeVersion: '',
    engines: '>=24.9.0',
    required: '24.9.0',
    running: '22.23.0',
    runningSatisfies: false,
    matched: null,
    installations: [],
    managers: [],
    installers: ['nvm'],
    error: '',
  };

  it('没声明版本 / 已装到 / 面板自己的就满足：都不提示', () => {
    assert.equal(nodeRunWarning({ ...base, required: '', nvmrc: '' }), '');
    assert.equal(
      nodeRunWarning({ ...base, matched: { manager: 'nvm', version: '24.9.0', binDir: '/n' } }),
      '',
    );
    assert.equal(nodeRunWarning({ ...base, runningSatisfies: true }), '');
  });

  it('缺版本时说明会用哪个版本跑，并指路去安装', () => {
    const text = nodeRunWarning(base);
    assert.match(text, /项目要求 Node 24\.9\.0/);
    assert.match(text, /面板当前的 v22\.23\.0/);
    assert.match(text, /项目配置 → Node 版本/);
  });

  it('连版本管理器都没有时改说让 AI 装', () => {
    const text = nodeRunWarning({ ...base, installers: [] });
    assert.match(text, /让 AI 装好/);
  });
});

describe('面板：缺版本时装哪个版本', () => {
  it('精确 / 前缀 / ^ ~ 能定版本', () => {
    assert.equal(nodeInstallTarget('22.23.0'), '22.23.0');
    assert.equal(nodeInstallTarget('v22'), '22');
    assert.equal(nodeInstallTarget('^22.23.0'), '22.23.0');
    assert.equal(nodeInstallTarget('~22.23'), '22.23');
    assert.equal(nodeInstallTarget(''), '');
  });

  it('范围取下界：装上它就能满足范围', () => {
    assert.equal(nodeInstallTarget('>=22.23.0'), '22.23.0');
    assert.equal(nodeInstallTarget('>=22.23.0 <23'), '22.23.0');
    assert.equal(nodeInstallTarget('>=20 <23'), '20');
    assert.equal(nodeInstallTarget('>20'), '20');
  });

  it('只有上界或 lts 别名时给不出具体版本', () => {
    assert.equal(nodeInstallTarget('<23'), '');
    assert.equal(nodeInstallTarget('<=22.23.0'), '');
    assert.equal(nodeInstallTarget('lts/*'), '');
  });
});

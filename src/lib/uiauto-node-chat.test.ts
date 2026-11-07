import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { nodeInstallInstruction } from './uiauto-node-chat';
import type { ProjectNodeStatus } from './ui-auto-node';

function status(patch: Partial<ProjectNodeStatus> = {}): ProjectNodeStatus {
  return {
    nvmrc: '',
    nodeVersion: '',
    engines: '>=22.23.0',
    required: '>=22.23.0',
    running: '22.23.0',
    runningSatisfies: false,
    matched: null,
    installations: [],
    managers: [],
    installers: [],
    error: '',
    ...patch,
  };
}

describe('让 AI 装 Node：任务卡正文', () => {
  it('写清项目目录、要求来源和建议版本', () => {
    const body = nodeInstallInstruction(
      { name: 'web-e2e', dir: '/work/web-e2e' },
      status(),
      '22.23.0',
    );
    assert.match(body, /项目目录：\/work\/web-e2e/);
    assert.match(body, /项目要求的版本：>=22\.23\.0/);
    assert.match(body, /engines\.node/);
    assert.match(body, /建议装的具体版本：22\.23\.0/);
  });

  it('.nvmrc 优先作为来源', () => {
    const body = nodeInstallInstruction(
      { name: 'p', dir: '/p' },
      status({ nvmrc: '20.11.1', engines: '>=20', required: '20.11.1' }),
      '20.11.1',
    );
    assert.match(body, /来自 \.nvmrc 里的 20\.11\.1/);
  });

  it('一个版本都没扫到时说明白', () => {
    const body = nodeInstallInstruction({ name: 'p', dir: '/p' }, status(), '');
    assert.match(body, /平台没扫到 nvm \/ fnm \/ volta/);
    assert.match(body, /平台检测到的版本管理器：一个都没有/);
    assert.doesNotMatch(body, /建议装的具体版本/);
  });

  it('本机装有哪些版本管理器也告诉模型', () => {
    const body = nodeInstallInstruction(
      { name: 'p', dir: '/p' },
      status({ installers: ['nvm'] }),
      '22.23.0',
    );
    assert.match(body, /平台检测到的版本管理器：nvm/);
  });

  it('服务端还没返回 installers 时退回用 managers，不抛错', () => {
    const legacy = { ...status({ managers: ['fnm'] }), installers: undefined };
    const body = nodeInstallInstruction(
      { name: 'p', dir: '/p' },
      legacy as unknown as ProjectNodeStatus,
      '22.23.0',
    );
    assert.match(body, /平台检测到的版本管理器：fnm/);
  });

  it('列出已装版本与当前进程版本', () => {
    const body = nodeInstallInstruction(
      { name: 'p', dir: '/p' },
      status({
        installations: [{ manager: 'nvm', version: '20.11.1', binDir: '/n/20' }],
      }),
      '',
    );
    assert.match(body, /本机已装的版本：20\.11\.1（nvm）/);
    assert.match(body, /当前会话进程用的版本：22\.23\.0/);
  });

  it('约束里不许改全局默认、必须验证 node -v', () => {
    const body = nodeInstallInstruction({ name: 'p', dir: '/p' }, status(), '');
    assert.match(body, /不要动用户全局默认版本/);
    assert.match(body, /node -v/);
    assert.match(body, /不要顺手装依赖/);
  });
});

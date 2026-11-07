/**
 * Node 版本装不上时「让 AI 处理」：把项目目录注册成工作区，跳工作台会话，
 * 并把「装哪个版本、本机现在什么情况、装完怎么验」写成任务卡。
 *
 * 为什么不把一切都交给 AI：能用 nvm / fnm / volta 直接装的情况，平台自己跑更快、
 * 日志也可控（`/project/node/install`）。这里只留给确定性方案搞不定的场景：
 * 本机一个版本管理器都没有、声明只有上界定不出具体版本、公司镜像 / 代理要换源。
 */
import { addWorkspace } from './fs-tools';
import { addComposerTask } from './composer-task';
import { sessionHandoffKey } from './open-docs-in-session';
import {
  createSession,
  flushSessionStore,
  hydrateSessionStore,
  loadSessionStore,
  type SessionStore,
} from './sessions';
import { hydrateAppConfig, loadAccessLevel } from './settings';
import { pickWorkspaceSession } from './open-project-in-session';
import type { ProjectNodeStatus } from './ui-auto-node';

export interface NodeInstallTarget {
  id: string;
  name: string;
  dir: string;
}

/** 声明来源的中文说法，写进提示里让模型知道优先级 */
function requirementSource(status: ProjectNodeStatus): string {
  if (status.nvmrc) return `.nvmrc 里的 ${status.nvmrc}`;
  if (status.nodeVersion) return `.node-version 里的 ${status.nodeVersion}`;
  if (status.engines) return `package.json 的 engines.node（${status.engines}）`;
  return '';
}

/** 拼「帮我把这个项目的 Node 版本装上」的要求（纯函数，便于测试） */
export function nodeInstallInstruction(
  project: { name: string; dir: string },
  status: ProjectNodeStatus,
  target: string,
): string {
  const source = requirementSource(status);
  const installed = status.installations.map((item) => `${item.version}（${item.manager}）`);
  const lines: string[] = [];
  lines.push(`帮我给项目「${project.name}」装好跑用例需要的 Node 版本。`);
  lines.push('');
  lines.push(`项目目录：${project.dir}`);
  if (status.required) {
    lines.push(`项目要求的版本：${status.required}${source ? `，来自 ${source}` : ''}`);
  } else {
    lines.push('项目没声明 Node 版本（没有 .nvmrc / .node-version，engines 里也没有）。');
  }
  if (target) lines.push(`平台建议装的具体版本：${target}（装上它能满足上面的要求）`);
  lines.push(
    `本机已装的版本：${
      installed.length ? installed.join('、') : '平台没扫到 nvm / fnm / volta 里的任何 Node'
    }`,
  );
  const installers = status.installers ?? status.managers ?? [];
  lines.push(
    `平台检测到的版本管理器：${
      installers.length ? installers.join(' / ') : '一个都没有（nvm / fnm / volta 都没装）'
    }`,
  );
  lines.push(`当前会话进程用的版本：${status.running}`);
  lines.push('');
  lines.push('要求：');
  lines.push(
    '1. 先看清楚本机装了哪个版本管理器（`nvm` / `fnm` / `volta`，nvm 是 shell 函数，要先 `source ~/.nvm/nvm.sh`），选已装的那个来装；一个都没有时再考虑装一个，装之前先跟我说装哪个、装到哪。',
  );
  lines.push(
    '2. 只装这个版本，不要动用户全局默认版本（不要执行 `nvm alias default` / `fnm default`），也不要把版本写进用户 shell 配置文件。',
  );
  lines.push(
    '3. 如果下载卡住或超时，先判断是不是网络 / 镜像问题：nvm 用 `NVM_NODEJS_ORG_MIRROR`、fnm 用 `FNM_NODE_DIST_MIRROR` 指到国内镜像再试一次，并把用的镜像地址告诉我。',
  );
  lines.push('4. 装完必须验证：用该版本执行 `node -v` 并把真实输出贴给我；不要只说「已安装」。');
  lines.push('5. 不要顺手装依赖、不要跑用例、不要改项目里的文件；这次只解决 Node 版本。');
  lines.push(
    '6. 如果需要 sudo、需要交互式输入，或者反复失败，就停下来告诉我卡在哪一步、需要我做什么，不要一直重试。',
  );
  return lines.join('\n');
}

/**
 * 打开工作台会话让 AI 执行安装：同一目录已有会话就复用，没有就新建。
 * 失败时抛错，由调用方 toast。
 */
export async function openNodeInstallInChat(
  project: NodeInstallTarget,
  status: ProjectNodeStatus,
  target: string,
): Promise<void> {
  const dir = project.dir?.trim();
  if (!dir) throw new Error('项目目录为空，请重新指定目录');

  await addWorkspace(dir);
  await hydrateSessionStore().catch(() => null);
  await hydrateAppConfig().catch(() => null);
  let store: SessionStore = loadSessionStore();
  const existing = pickWorkspaceSession(store.sessions, dir);
  if (existing) {
    store = { ...store, activeId: existing.id };
  } else {
    store = createSession(store, { workspacePath: dir, access: loadAccessLevel() });
    await flushSessionStore(store);
  }

  const sessionId = store.activeId;
  const chat = store.sessions.find((s) => s.id === sessionId);
  if (!chat) throw new Error('无法创建或定位会话');

  const version = target || status.required || '';
  addComposerTask(sessionId, {
    id: `node-install:${project.id}:${version}`,
    label: version ? `安装 Node ${version}` : '安装 Node',
    detail: project.name,
    body: nodeInstallInstruction({ name: project.name, dir }, status, target),
    at: Date.now(),
  });

  try {
    sessionStorage.setItem(sessionHandoffKey(chat.id), JSON.stringify({ session: chat }));
  } catch {
    // 隐私模式等忽略
  }

  const base = import.meta.env.BASE_URL || '/';
  const query = new URLSearchParams({ session: sessionId });
  window.location.href = `${base}workbench/?${query.toString()}`;
}

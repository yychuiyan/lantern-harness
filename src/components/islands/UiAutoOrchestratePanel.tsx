/**
 * 脚本编排详情里的会话：嵌入工作台 ChatApp（同源会话）。
 * 编排阶段会话为只读 + 纪律提示：只拆步骤，不写码、不跑测。
 */
import { memo } from 'react';

import {
  appendSessionMessage,
  flushSessionStore,
  hydrateSessionStore,
  loadSessionStore,
} from '../../lib/sessions';
import ChatApp from './ChatApp';

function UiAutoOrchestratePanel({
  chatSessionId,
  projectDir,
  projectName,
}: {
  chatSessionId: string;
  /** 当前自动化项目目录：嵌入会话工作区固定为此路径 */
  projectDir: string;
  projectName: string;
  /** @deprecated 完整会话后不再需要本地意图回调 */
  busy?: boolean;
  onPlanSteps?: () => void;
  onExplore?: () => void;
  onEmitCode?: () => void;
  onContinueExplore?: () => void;
  canContinue?: boolean;
  embedded?: boolean;
  onUserSend?: () => void;
}) {
  // 详情打开瞬间 chatSessionId 还没绑上：留白即可，别闪「开始描述需求」
  if (!chatSessionId) {
    return <div className="h-full min-h-0 bg-white" aria-busy="true" />;
  }

  return (
    <div className="h-full min-h-0 overflow-hidden">
      <ChatApp
        embedded
        lockedSessionId={chatSessionId}
        lockedWorkspacePath={projectDir}
        lockedWorkspaceLabel={projectName}
      />
    </div>
  );
}

/** 左侧改需求时父组件会重渲染；props 不变就别重画整棵 ChatApp */
export default memo(UiAutoOrchestratePanel);

/** 供外部在长任务结束时往同一会话插一条摘要（嵌入的 ChatApp 会监听刷新） */
export async function appendOrchestrateNotice(chatSessionId: string, text: string) {
  if (!chatSessionId || !text.trim()) return;
  await hydrateSessionStore().catch(() => null);
  let store = loadSessionStore();
  store = appendSessionMessage(store, chatSessionId, {
    id: `ua_n_${Date.now().toString(36)}`,
    role: 'assistant',
    content: text.trim(),
    createdAt: Date.now(),
  });
  await flushSessionStore(store);
  try {
    window.dispatchEvent(
      new CustomEvent('lantern:chat-session-updated', { detail: { sessionId: chatSessionId } }),
    );
  } catch {
    // ignore
  }
}

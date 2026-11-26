import crypto from 'node:crypto';

const TTL = 30 * 60 * 1000;
const fail = (message, statusCode = 400) => {
  throw Object.assign(new Error(message), { statusCode });
};

/** Browser confirmation stores selections only; it never generates cases. */
export function createCaseSetupWindows({ setup, context }) {
  const sessions = new Map();
  const read = (root, id) => {
    for (const [key, value] of sessions) {
      if (value.expiresAt <= Date.now()) sessions.delete(key);
    }
    const session = sessions.get(id);
    if (!session || session.root !== root) fail('配置窗口已过期或不属于当前空间，请重新打开', 404);
    return session;
  };
  const payload = (session) => ({
    ok: true,
    action:
      session.status === 'confirmed'
        ? 'accept'
        : session.status === 'cancelled'
          ? 'cancel'
          : 'browser',
    setupId: session.id,
    status: session.status,
    expiresAt: session.expiresAt,
    configurationPath: `/cases/configure/#${session.id}`,
    requiresConfirmation: session.status === 'pending',
    ...(session.status === 'confirmed' ? { config: session.config } : {}),
    ...(session.status === 'pending' ? { setup: session.setup } : {}),
    message:
      session.status === 'confirmed'
        ? '配置已确认，可返回聊天继续生成用例。'
        : session.status === 'cancelled'
          ? '配置已取消，未生成用例。'
          : '请在浏览器配置窗口中选择并确认；此操作不会生成用例。',
  });
  return {
    async create(root, raw) {
      if (sessions.size >= 100) {
        for (const [key, value] of sessions)
          if (value.expiresAt <= Date.now()) sessions.delete(key);
        if (sessions.size >= 100) fail('待处理配置窗口过多，请稍后重试', 429);
      }
      const session = {
        id: crypto.randomUUID(),
        root,
        status: 'pending',
        expiresAt: Date.now() + TTL,
        setup: await setup(root, raw),
      };
      sessions.set(session.id, session);
      return payload(session);
    },
    get(root, id) {
      return payload(read(root, id));
    },
    cancel(root, id) {
      const session = read(root, id);
      if (session.status !== 'pending') fail('配置窗口已完成，请勿重复操作', 409);
      session.status = 'cancelled';
      return payload(session);
    },
    async confirm(root, id, selection) {
      const session = read(root, id);
      if (session.status !== 'pending') fail('配置窗口已完成，请勿重复确认', 409);
      const source = selection.reqSource;
      if (source?.kind !== 'doc' && source?.kind !== 'stories') fail('请选择需求文档或用户故事');
      const config = {
        caseType: selection.caseType,
        outputFormat: selection.outputFormat,
        ...(source.kind === 'stories'
          ? {
              analysisId: source.docId,
              storyIds: source.storyIds,
              storySelection: 'selected',
              testPointIds: selection.testPointIds || [],
              testPointSelection: 'selected',
            }
          : { sourcePath: source.path }),
        templateId: selection.templateId,
        requirementBreakdownId: selection.requirementBreakdownContext?.entryId,
        requirementBreakdownMode: selection.requirementBreakdownContext?.entryId
          ? 'manual'
          : 'none',
        businessSystemIds: (selection.businessContexts || []).map((item) => item.systemId),
        businessSystemMode: 'manual',
      };
      if (!['xlsx', 'csv', 'md'].includes(config.outputFormat)) fail('请选择有效的输出格式');
      if (source.kind === 'stories' && (!Array.isArray(source.storyIds) || !source.storyIds.length))
        fail('请至少选择一条用户故事');
      if (source.kind === 'doc' && !source.path) fail('请选择需求文档');
      const current = await context(root, config);
      if (source.kind === 'stories') {
        const storyIds = new Set(current.analysis.stories.map((item) => item.id));
        const pointIds = new Set(
          (current.analysis.testPoints?.points || [])
            .filter((item) => !item.storyId || storyIds.has(item.storyId))
            .map((item) => item.id),
        );
        if (
          source.storyIds.some((id) => !storyIds.has(id)) ||
          config.testPointIds.some((id) => !pointIds.has(id))
        )
          fail('所选故事或测试点已变化，请重新选择', 409);
      }
      const baseline = selection.baseline;
      if (
        !baseline ||
        baseline.revision !== current.revision ||
        baseline.sourceFileHash !== current.sourceFileHash
      )
        fail('需求基线已变化，请重新读取配置', 409);
      // Another request may have completed while the source was being read.
      if (read(root, id).status !== 'pending') fail('配置窗口已完成，请勿重复确认', 409);
      session.status = 'confirmed';
      session.config = config;
      return payload(session);
    },
  };
}

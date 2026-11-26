import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCaseSetupWindows } from '../../lh-plugins/case-setup-window.mjs';

function fixture() {
  const windows = createCaseSetupWindows({
    setup: async () => ({ recommended: { analysisId: 'analysis' } }),
    context: async () => ({
      revision: 'r1',
      sourceFileHash: 'hash',
      analysis: {
        stories: [{ id: 'US-1' }],
        testPoints: {
          points: [
            { id: 'TP-1', storyId: 'US-1' },
            { id: 'TP-2', storyId: 'US-2' },
          ],
        },
      },
    }),
  });
  const selection = {
    caseType: 'functional',
    outputFormat: 'xlsx',
    reqSource: { kind: 'stories', docId: 'analysis', storyIds: ['US-1'] },
    testPointIds: ['TP-1'],
    baseline: { revision: 'r1', sourceFileHash: 'hash' },
  };
  return { windows, selection };
}

test('配置只在确认后返回，文档与故事保持二选一，已完成窗口不可重写', async () => {
  const { windows, selection } = fixture();
  const pending = await windows.create('/space', {});
  assert.equal(pending.config, undefined);
  assert.equal(pending.requiresConfirmation, true);
  const confirmed = await windows.confirm('/space', pending.setupId, selection);
  assert.equal(confirmed.action, 'accept');
  assert.equal(confirmed.config.sourcePath, undefined);
  assert.equal(confirmed.config.analysisId, 'analysis');
  await assert.rejects(windows.confirm('/space', pending.setupId, selection), /重复确认/);
  assert.throws(() => windows.cancel('/space', pending.setupId), /重复操作/);
  const doc = await windows.create('/space', {});
  const docResult = await windows.confirm('/space', doc.setupId, {
    ...selection,
    reqSource: { kind: 'doc', path: '需求.md' },
  });
  assert.equal(docResult.config.analysisId, undefined);
  assert.equal(docResult.config.storyIds, undefined);
  assert.equal(docResult.config.sourcePath, '需求.md');
});

test('拒绝过期、跨空间、基线变化及其他故事的测试点', async (t) => {
  const { windows, selection } = fixture();
  const pending = await windows.create('/space', {});
  assert.throws(() => windows.get('/other-space', pending.setupId), /不属于当前空间/);
  await assert.rejects(
    windows.confirm('/space', pending.setupId, {
      ...selection,
      baseline: { revision: 'old', sourceFileHash: 'hash' },
    }),
    /基线已变化/,
  );
  await assert.rejects(
    windows.confirm('/space', pending.setupId, { ...selection, testPointIds: ['TP-2'] }),
    /测试点已变化/,
  );
  assert.equal(windows.get('/space', pending.setupId).status, 'pending');
  t.mock.method(Date, 'now', () => pending.expiresAt + 1);
  assert.throws(() => windows.get('/space', pending.setupId), /已过期/);
});

test('取消不返回生成配置', async () => {
  const { windows, selection } = fixture();
  const pending = await windows.create('/space', {});
  assert.equal(windows.cancel('/space', pending.setupId).action, 'cancel');
  assert.equal(windows.get('/space', pending.setupId).config, undefined);
  await assert.rejects(windows.confirm('/space', pending.setupId, selection), /重复确认/);
});

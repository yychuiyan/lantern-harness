import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createBusinessAssistantService } from '../../lh-plugins/business-map/assistant.mjs';
import { normalizeFlowLinks, flowLinkIssues } from '../../lh-plugins/business-map/flow-links.mjs';
import { validateBusinessMapSystem } from '../../lh-plugins/lh-business-map.mjs';
import { localPublishCheck, normalizeSystem } from './business-map';

test('前后端结构校验均拦截不存在的下一步', () => {
  const system = normalizeSystem({
    name: '跳转校验',
    functions: [{ id: 'fn', name: '办理', purpose: '办理业务' }],
    flows: [{ name: '无效跳转', steps: [{ n: 1, title: '办理', functionId: 'fn', next: '99' }] }],
  });
  for (const check of [localPublishCheck(system), validateBusinessMapSystem(system)]) {
    assert.equal(check.ok, false);
    assert.ok(check.items.some((item: { code: string }) => item.code === 'invalid_flow_links'));
  }
});

test('步骤重编号同步跳转及条件目标，已连通分支不误报', () => {
  const steps = normalizeFlowLinks([
    { n: 10, next: '20', branch: '通过→20；退回→10', branchBroken: false },
    { n: 20, next: '', branch: '' },
  ]);
  assert.equal(steps[0].next, '2');
  assert.equal(steps[0].branch, '通过→2；退回→1');
  assert.equal(steps[0].branchBroken, false);
  assert.deepEqual(flowLinkIssues(steps), []);
  assert.ok(flowLinkIssues([{ n: 1, next: '99' }]).length);
  assert.ok(
    flowLinkIssues([
      { n: 1, next: '' },
      { n: 1, next: '' },
    ]).length,
  );
  assert.equal(normalizeFlowLinks([{ n: 1, next: '', branch: '通过→99' }])[0].branchBroken, true);
  assert.equal(
    normalizeFlowLinks([{ n: 1, next: '', branch: '通过→结束；退回待确认' }])[0].branchBroken,
    true,
  );
});

test('流程生成过滤伪证据和无承载功能，补充回合带上草案、已有流程和历史', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-flow-generation-'));
  const system = {
    id: 'flow-test',
    name: '测试系统',
    directories: [],
    functions: [{ id: 'fn', name: '审核' }],
    flows: [{ name: '已存流程', steps: [{ title: '原有步骤' }] }],
  };
  const refs = [{ sourceId: 'source', quote: '审核通过后办结' }];
  const base = {
    name: '有效流程',
    steps: [
      {
        n: 10,
        title: '审核',
        functionId: 'fn',
        manual: false,
        next: '20',
        branch: '通过→20；退回→10',
        branchBroken: false,
      },
      { n: 20, title: '办结', functionId: 'fn', next: '' },
    ],
    evidence: refs,
  };
  const service = createBusinessAssistantService({
    pages: async () => ({
      pages: [{ id: 'p', title: '审核', url: 'https://example.com' }],
      evidence: [{ id: 'source', content: '审核通过后办结，退回时补充材料' }],
      issues: [],
    }),
    applyDirectoryProposal: () => ({ store: {}, applied: {} }),
    applyFlowProposal: () => ({ store: {}, applied: {} }),
    model: async (_settings: unknown, messages: Array<{ content: string }>) => {
      contexts.push(JSON.parse(messages[1].content));
      return {
        value: {
          flows: [
            base,
            {
              ...base,
              name: '伪证据',
              evidence: [{ sourceId: 'source', quote: '虚构的证据内容' }],
            },
            { ...base, name: '漏关联', steps: [{ n: 1, title: '系统动作', manual: false }] },
            {
              ...base,
              name: '无效关联',
              steps: [{ n: 1, title: '系统动作', functionId: 'unknown', manual: false }],
            },
            {
              ...base,
              name: '错误跳转',
              steps: [{ n: 1, title: '系统动作', functionId: 'fn', next: '99' }],
            },
            {
              ...base,
              name: '人工流程',
              steps: [{ n: 1, title: '人工确认', manual: true, next: '' }],
            },
          ],
        },
        usage: {},
      };
    },
  });
  const contexts: Array<{
    previousProposal: unknown;
    currentFlows: unknown;
    conversation: Array<{ content: string }>;
  }> = [];
  const settings = { baseURL: 'https://example.com', apiKey: 'fake', model: 'fake' };
  const wait = async () => {
    for (let i = 0; i < 100; i++) {
      const session = service.get(root, system);
      if (session.status === 'awaiting_confirmation') return session;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('未生成流程草案');
  };
  try {
    service.start(root, system, { phase: 'flow', message: '生成流程' }, settings);
    const first = await wait();
    assert.deepEqual(
      first.proposal.flows.map((f: { name: string }) => f.name),
      ['有效流程', '人工流程'],
    );
    assert.equal(first.proposal.flows[0].steps[0].next, '2');
    assert.equal(first.proposal.flows[0].steps[0].branchBroken, false);
    assert.equal(first.proposal.warnings.length, 4);
    service.start(root, system, { phase: 'flow', message: '增加归档步骤，其他不变' }, settings);
    await wait();
    assert.deepEqual(contexts[1].previousProposal, first.proposal);
    assert.deepEqual(contexts[1].currentFlows, system.flows);
    assert.ok(contexts[1].conversation.some((m: { content: string }) => m.content === '生成流程'));
  } finally {
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

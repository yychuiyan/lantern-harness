import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CASE_GEN_BATCH_SIZE,
  caseGenConfigForBatch,
  parseTestPointBlockSegments,
  planCaseGenBatches,
  rebuildTestPointBlock,
  shouldBatchCaseGen,
  type CaseGenBatchPlan,
} from './case-gen-batch';
import type { CaseGenPluginConfig } from './case-gen-config';
import {
  formatCaseGenProgress,
  isCaseGenBatchMetaUncovered,
  mergeCaseGenPayloads,
  softCaseGenPercent,
} from './case-gen-run';

function cfg(partial: Partial<CaseGenPluginConfig> = {}): CaseGenPluginConfig {
  return {
    active: true,
    caseType: 'functional',
    outputFormat: 'xlsx',
    templateHeaders: ['用例编号', '用例标题'],
    templateBody: '',
    promptBody: '写用例',
    confirmedAt: 1,
    ...partial,
  };
}

function makeBlock(ids: string[]): string {
  const lines: string[] = ['#### US-001'];
  for (const id of ids) {
    lines.push(`- **[P0]** 标题 ${id}（${id}）`);
    lines.push(`  - 来源故事：US-001`);
    lines.push(`  - 维度：功能`);
    lines.push(`  - 步骤：点一下`);
    lines.push(`  - 预期：成功`);
  }
  return lines.join('\n');
}

describe('parseTestPointBlockSegments / rebuild', () => {
  it('按 TP id 拆段并重建子集', () => {
    const block = makeBlock(['TP-001', 'TP-002', 'TP-003']);
    const segs = parseTestPointBlockSegments(block);
    assert.equal(segs.length, 3);
    assert.deepEqual(
      segs.map((s) => s.id),
      ['TP-001', 'TP-002', 'TP-003'],
    );
    const rebuilt = rebuildTestPointBlock(segs, ['TP-002', 'TP-003']);
    assert.ok(rebuilt.includes('TP-002'));
    assert.ok(rebuilt.includes('TP-003'));
    assert.ok(!rebuilt.includes('TP-001'));
    assert.ok(rebuilt.includes('#### US-001'));
  });
});

describe('planCaseGenBatches', () => {
  it('未超阈值时单批', () => {
    const ids = Array.from({ length: CASE_GEN_BATCH_SIZE }, (_, i) => `TP-${i + 1}`);
    const plans = planCaseGenBatches(cfg({ testPointIds: ids, testPointBlock: makeBlock(ids) }));
    assert.equal(plans.length, 1);
    assert.equal(plans[0]!.ids.length, CASE_GEN_BATCH_SIZE);
    assert.equal(shouldBatchCaseGen(cfg({ testPointIds: ids })), false);
  });

  it('超阈值时按 40 条切分且块收窄', () => {
    const ids = Array.from({ length: 95 }, (_, i) => `TP-${String(i + 1).padStart(3, '0')}`);
    const plans = planCaseGenBatches(cfg({ testPointIds: ids, testPointBlock: makeBlock(ids) }));
    assert.equal(plans.length, 3);
    assert.equal(plans[0]!.ids.length, 40);
    assert.equal(plans[1]!.ids.length, 40);
    assert.equal(plans[2]!.ids.length, 15);
    assert.equal(plans[0]!.index, 1);
    assert.equal(plans[2]!.total, 3);
    assert.ok(plans[0]!.testPointBlock.includes('TP-001'));
    assert.ok(!plans[0]!.testPointBlock.includes('TP-041'));
    assert.ok(plans[1]!.testPointBlock.includes('TP-041'));
    const sliced = caseGenConfigForBatch(
      cfg({ testPointIds: ids, testPointBlock: makeBlock(ids) }),
      plans[0]!,
    );
    assert.equal(sliced.testPointIds?.length, 40);
    assert.equal(shouldBatchCaseGen(cfg({ testPointIds: ids })), true);
  });

  it('每批只注入与本批测试点相关的业务地图和 XMind 分支', () => {
    const shared = cfg({
      requirementBreakdownContext: {
        entryId: 'rbl_1',
        title: '工单需求',
        fileName: '工单需求.xmind',
        block: [
          '### 需求拆解库',
          '- 工单系统',
          '  - 工单受理',
          '    - 新建工单',
          '  - 工单归档',
          '    - 归档工单',
        ].join('\n'),
      },
      businessContext: {
        systemId: 'sys_1',
        systemName: '工单系统',
        functionCount: 2,
        flowCount: 2,
        block: [
          '### 业务地图：工单系统',
          '- 功能：2 个；业务流程：2 条',
          '#### 功能目录与规则',
          '- F-001 新建工单｜目录：工单受理',
          '  - 作用：登记并新建工单',
          '- F-002 归档工单｜目录：工单归档',
          '  - 作用：归档已办结工单',
          '#### 业务流程',
          '- P1 新建工单流程',
          '  1. 登记并提交新建工单',
          '- P2 归档工单流程',
          '  1. 执行工单归档｜依赖=档案系统·写入归档编号',
          '#### 跨系统依赖',
          '- P2「执行工单归档」→ 档案系统·写入归档编号',
        ].join('\n'),
      },
    });
    const firstBatch: CaseGenBatchPlan = {
      index: 1,
      total: 2,
      ids: ['TP-001'],
      testPointBlock: '- **新建工单成功**（TP-001）',
      label: '新建工单',
    };
    const secondBatch: CaseGenBatchPlan = {
      index: 2,
      total: 2,
      ids: ['TP-002'],
      testPointBlock: '- **归档工单成功**（TP-002）',
      label: '归档工单',
    };
    const first = caseGenConfigForBatch(shared, firstBatch);
    const second = caseGenConfigForBatch(shared, secondBatch);
    assert.match(first.businessContext?.block || '', /F-001 新建工单/);
    assert.equal(first.businessContext?.block.includes('F-002 归档工单'), false);
    assert.match(second.businessContext?.block || '', /F-002 归档工单/);
    assert.equal(second.businessContext?.block.includes('F-001 新建工单'), false);
    assert.match(second.businessContext?.block || '', /档案系统·写入归档编号/);
    assert.match(first.requirementBreakdownContext?.block || '', /新建工单/);
    assert.equal(first.requirementBreakdownContext?.block.includes('归档工单'), false);
    assert.match(second.requirementBreakdownContext?.block || '', /归档工单/);
  });
});

describe('mergeCaseGenPayloads / soft progress', () => {
  it('合并用例与未覆盖，并滤掉分批范围说明', () => {
    const noise =
      '本批仅覆盖指定的 40 条测试点（US-022~US-032），均已落成用例；这些故事中未被本批测试点列出的验收标准由其他批次负责，不计入本批缺口';
    assert.equal(isCaseGenBatchMetaUncovered(noise), true);
    assert.equal(isCaseGenBatchMetaUncovered('RO-E-2-30 同步时延未给出，未单独成例'), false);
    const merged = mergeCaseGenPayloads([
      {
        docTitle: 'A',
        cases: [{ 用例标题: '1' }, { 用例标题: '2' }],
        coverageRate: 100,
        uncovered: [noise, '缺口A'],
        writeNote: '批1',
      },
      {
        docTitle: 'B',
        cases: [{ 用例标题: '3' }],
        coverageRate: 80,
        uncovered: ['缺口A', '缺口B', '本批测试点均已落成用例'],
        writeNote: '批2',
      },
    ]);
    assert.ok(merged);
    assert.equal(merged!.cases.length, 3);
    assert.equal(merged!.docTitle, 'A');
    assert.deepEqual(merged!.uncovered, ['缺口A', '缺口B']);
    assert.ok(merged!.writeNote.includes('批1'));
    assert.ok(merged!.writeNote.includes('批2'));
    // (100*2 + 80*1) / 3
    assert.equal(merged!.coverageRate, 93);
  });

  it('软进度单调且不超过 95，文案无固定秒数区间', () => {
    assert.ok(softCaseGenPercent(0) <= softCaseGenPercent(60));
    assert.ok(softCaseGenPercent(60) <= softCaseGenPercent(180));
    assert.ok(softCaseGenPercent(1000) <= 95);
    const text = formatCaseGenProgress(137, { index: 2, total: 6, label: 'TP-041…TP-080' });
    assert.ok(text.includes('第 2/6 批'));
    assert.ok(text.includes('已用 137s'));
    assert.ok(text.includes('进度约'));
    assert.ok(!text.includes('通常约'));
  });
});

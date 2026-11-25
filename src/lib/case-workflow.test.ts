import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  assessExecutionEvidence,
  assertTargetUrl,
  validateDefectLinks,
} from '../../builtin/case-workflow-contract.mjs';
import {
  caseDesignContext,
  validateCaseDesign,
  saveCaseDesign,
  caseAcceptance,
  linkCaseBaseline,
} from '../../lh-plugins/lh-case-design.mjs';
import {
  applyCaseFieldUpdates,
  loadCaseDocument,
  prepareExecutionColumns,
} from '../../lh-plugins/case-execution/files.mjs';
import {
  createExecutionPlan,
  startExecutionPlan,
  getExecutionPlan,
  verifyExecutionPlanItem,
} from '../../lh-plugins/case-execution/plans.mjs';
import { confirmRun } from '../../lh-plugins/case-execution/service.mjs';
import { reqAnalysisStorePath, reqDocsDir } from '../../lh-plugins/lh-req-analysis.mjs';
import { recordManualVerification } from '../../lh-plugins/case-execution/assets.mjs';
import { analysisRevision } from '../../lh-plugins/req-analysis-revision.mjs';
import { ensurePluginPrompt } from '../../lh-plugins/plugin-prompts.mjs';
import {
  spaceConfigFile,
  spaceLocalFile,
  resolveContentRoot,
} from '../../builtin/session/space-layout.mjs';
import { __resetSpaceContext, setActiveRoot } from '../../builtin/session/space-context.mjs';

let root = '';
const analysis = {
  id: 'ra_workflow',
  title: '工单需求',
  sourcePath: '需求.md',
  sourceHash: 'sample',
  outline: [{ id: 'RO-1', title: '创建工单' }],
  stories: [{ id: 'US-001', title: '创建工单', sourceRefs: ['RO-1'] }],
  testPoints: { points: [{ id: 'TP-001', storyId: 'US-001', title: '成功创建' }] },
};
const headers = ['用例编号', '需求编号', '用例标题', '测试步骤', '预期结果', '引用需求点'];
const rows = [
  {
    用例编号: '1',
    需求编号: 'US-001',
    用例标题: '创建工单',
    测试步骤: '打开页面后创建',
    预期结果: '创建成功',
    引用需求点: 'RO-1；TP-001',
  },
];
function put(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-workflow-'));
  __resetSpaceContext();
  setActiveRoot(root);
  put(spaceConfigFile(root, 'app.defaults.json'), {
    version: 1,
    plugins: {},
    model: { activeId: '', providers: [] },
  });
  put(spaceLocalFile(root, 'app.config.json'), {
    version: 1,
    plugins: {
      cases: true,
      caseGen: true,
      caseExecution: true,
      reqAnalysis: true,
      caseReview: true,
    },
  });
  fs.mkdirSync(reqDocsDir(root), { recursive: true });
  fs.writeFileSync(path.join(reqDocsDir(root), '需求.md'), '# 创建工单\n填写内容后创建工单');
  put(reqAnalysisStorePath(root), { version: 1, docs: [analysis] });
  ensurePluginPrompt('功能测试用例提示词.md', '# 功能测试用例\n读取需求并编写真实用例', root);
});
afterEach(() => {
  __resetSpaceContext();
  fs.rmSync(root, { recursive: true, force: true });
});
async function generate(format = 'csv') {
  const context = await caseDesignContext(root, { analysisId: analysis.id });
  return saveCaseDesign(root, {
    analysisId: analysis.id,
    expectedRevision: context.revision,
    expectedSourceFileHash: context.sourceFileHash,
    headers,
    rows,
    title: '功能用例',
    format,
  });
}

describe('可信执行与缺陷地址契约', () => {
  it('无真实页面观察、步骤或断言的通过建议不具备证据', () => {
    assert.equal(
      assessExecutionEvidence({ status: '通过', stepResults: [], unverified: [] }, []).sufficient,
      false,
    );
    const result = {
      status: '通过',
      stepResults: [{ actual: '页面创建成功', evidence: '页面快照', passed: true }],
      unverified: [],
      blocker: '',
    };
    assert.equal(
      assessExecutionEvidence(result, [
        { type: 'tool', status: 'done', title: 'case_browser_open' },
      ]).sufficient,
      true,
    );
    assert.equal(
      assessExecutionEvidence({ ...result, unverified: ['错误提示未核验'] }, [
        { type: 'tool', status: 'done', title: 'case_browser_snapshot' },
      ]).sufficient,
      false,
    );
  });
  it('仅允许明确授权的目标 origin，并拒绝带凭据 URL', () => {
    assert.equal(assertTargetUrl('/a', 'https://target.test/'), 'https://target.test/a');
    assert.throws(() => assertTargetUrl('https://other.test', 'https://target.test'), /范围/);
    assert.throws(
      () => assertTargetUrl('https://name:password@target.test', 'https://target.test'),
      /范围/,
    );
    assert.equal(
      assertTargetUrl('https://login.test/sso', 'https://target.test', ['https://login.test']),
      'https://login.test/sso',
    );
  });
  it('多个缺陷地址去重、兼容旧单链接并拒绝脚本 URL', () => {
    assert.equal(
      validateDefectLinks('https://bugs.test/1\nhttps://bugs.test/2\nhttps://bugs.test/1'),
      'https://bugs.test/1\nhttps://bugs.test/2',
    );
    assert.equal(validateDefectLinks('https://bugs.test/1'), 'https://bugs.test/1');
    assert.throws(() => validateDefectLinks('javascript:alert(1)'), /HTTP/);
  });
});

describe('需求、用例与人工验收', () => {
  it('生成会补齐执行列，覆盖率由真实引用计算，不使用模型自报', async () => {
    const checked = validateCaseDesign({ rows, headers, coverageRate: 0 }, analysis);
    assert.equal(checked.coverage.RO.rate, 100);
    assert.equal(checked.coverage.TP.rate, 100);
    const saved = await generate();
    const document = await loadCaseDocument(root, saved.path);
    assert.equal(document.executable, true);
    assert.equal(document.cases[0].status, '待验证');
    assert.equal(document.cases[0].actual, '');
    assert.equal(document.provenance.analysisId, analysis.id);
    const report = await caseAcceptance(root, saved.path);
    assert.equal(report.acceptance.ready, false);
    assert.equal(report.pending, 1);
    await applyCaseFieldUpdates(root, {
      path: saved.path,
      expectedFileHash: document.fileHash,
      rowIndex: 0,
      updates: [
        { header: '用例状态', value: '通过' },
        { header: '实际结果', value: '人工核验创建成功' },
      ],
    });
    const accepted = await caseAcceptance(root, saved.path);
    assert.equal(accepted.acceptance.ready, true);
    assert.equal(accepted.progressCoverage.TP.passRate, 100);
  });
  it('拒绝不存在的需求引用和过期需求基线', async () => {
    assert.equal(
      validateCaseDesign({ headers, rows: [{ ...rows[0], 引用需求点: 'RO-999' }] }, analysis).ok,
      false,
    );
    const context = await caseDesignContext(root, { analysisId: analysis.id });
    put(reqAnalysisStorePath(root), { version: 1, docs: [{ ...analysis, title: '已变化' }] });
    await assert.rejects(
      saveCaseDesign(root, {
        analysisId: analysis.id,
        expectedRevision: context.revision,
        expectedSourceFileHash: context.sourceFileHash,
        headers,
        rows,
        title: '过期',
      }),
      /已变化/,
    );
  });
  it('来源需求变化后旧通过不计入当前验收，更新基线仍需人工复核', async () => {
    const saved = await generate();
    let document = await loadCaseDocument(root, saved.path);
    await applyCaseFieldUpdates(root, {
      path: saved.path,
      expectedFileHash: document.fileHash,
      rowIndex: 0,
      updates: [{ header: '用例状态', value: '通过' }],
    });
    const changed = { ...analysis, title: '工单需求新版本' };
    put(reqAnalysisStorePath(root), { version: 1, docs: [changed] });
    document = await loadCaseDocument(root, saved.path);
    assert.equal(document.provenance.stale, true);
    assert.equal(document.cases[0].status, '待验证');
    assert.equal(document.cases[0].storedStatus, '通过');
    await linkCaseBaseline(root, {
      casePath: saved.path,
      analysisId: analysis.id,
      mode: 'apply',
      expectedFileHash: document.fileHash,
      expectedRevision: analysisRevision(changed),
    });
    document = await loadCaseDocument(root, saved.path);
    assert.equal(document.cases[0].status, '待验证');
    await applyCaseFieldUpdates(root, {
      path: saved.path,
      expectedFileHash: document.fileHash,
      rowIndex: 0,
      updates: [{ header: '用例状态', value: '通过' }],
    });
    assert.equal((await caseAcceptance(root, saved.path)).acceptance.ready, true);
  });
  it('改名保留稳定标识，但两个同时存在的相同文件不共享基线和人工结果', async () => {
    const saved = await generate();
    const original = await loadCaseDocument(root, saved.path);
    const dir = resolveContentRoot(root, '用例管理').abs;
    fs.copyFileSync(path.join(dir, saved.path), path.join(dir, '副本.csv'));
    const copy = await loadCaseDocument(root, '副本.csv');
    assert.notEqual(copy.provenance.artifactId, original.provenance.artifactId);
    assert.notEqual(copy.cases[0].id, original.cases[0].id);
    fs.renameSync(path.join(dir, saved.path), path.join(dir, '已改名.csv'));
    const renamed = await loadCaseDocument(root, '已改名.csv');
    assert.equal(renamed.cases[0].id, original.cases[0].id);
    assert.equal(renamed.provenance.analysisId, analysis.id);
  });
  it('原有 CSV/Markdown/Excel 的多缺陷地址写入可重新读取', async () => {
    for (const format of ['csv', 'md', 'xlsx']) {
      const saved = await generate(format);
      const document = await loadCaseDocument(root, saved.path);
      await applyCaseFieldUpdates(root, {
        path: saved.path,
        expectedFileHash: document.fileHash,
        rowIndex: 0,
        updates: [{ header: '缺陷地址', value: 'https://bugs.test/1\nhttps://bugs.test/2' }],
      });
      assert.equal(
        (await loadCaseDocument(root, saved.path)).cases[0].defectUrl,
        'https://bugs.test/1\nhttps://bugs.test/2',
      );
    }
  });
  it('沿用既有模板别名与带注释执行列，生成不接受模型自填通过', async () => {
    const customHeaders = [
      '编号',
      '测试内容',
      '操作过程',
      '预期内容',
      '用例状态（必填）',
      '实际结果（必填）',
    ];
    const customRows = [
      {
        编号: '1',
        测试内容: '创建',
        操作过程: '填写创建',
        预期内容: '成功',
        '用例状态（必填）': '通过',
        '实际结果（必填）': '模型伪造',
      },
    ];
    const saved = await saveCaseDesign(root, {
      title: '旧模板',
      format: 'csv',
      headers: customHeaders,
      rows: customRows,
    });
    const document = await loadCaseDocument(root, saved.path);
    assert.equal(document.cases[0].title, '创建');
    assert.equal(document.cases[0].steps, '填写创建');
    assert.equal(document.headers.length, customHeaders.length);
    assert.equal(document.cases[0].status, '待验证');
    assert.equal(document.cases[0].actual, '');
  });

  it('按环境隔离人工验证历史，不将一个环境的通过移到另一个环境', async () => {
    const saved = await generate();
    const document = await loadCaseDocument(root, saved.path);
    document.cases[0].status = '通过';
    recordManualVerification(root, document, 0, { name: '集成', role: '管理员', build: 'v1' });
    document.cases[0].status = '不通过';
    recordManualVerification(root, document, 0, { name: '预发', role: '管理员', build: 'v1' });
    const all = await caseAcceptance(root, saved.path);
    assert.ok(all.acceptance.reasons.some((reason) => reason.includes('多个环境')));
    const integration = all.environments.find((env) => env.label.includes('集成'))!;
    const staging = all.environments.find((env) => env.label.includes('预发'))!;
    assert.equal((await caseAcceptance(root, saved.path, integration.key)).passed, 1);
    assert.equal((await caseAcceptance(root, saved.path, staging.key)).failed, 1);
  });

  it('重新关联基线后拒绝启动基于旧版本创建的计划', async () => {
    const saved = await generate();
    const document = await loadCaseDocument(root, saved.path);
    const plan = await createExecutionPlan(root, {
      casePath: saved.path,
      expectedFileHash: document.fileHash,
      caseIds: [document.cases[0].id],
      engine: 'automation',
      projectId: 'missing',
      file: 'test.py',
      environment: { name: 'test', build: 'v1' },
    });
    const changed = { ...analysis, title: '新基线' };
    put(reqAnalysisStorePath(root), { version: 1, docs: [changed] });
    await linkCaseBaseline(root, {
      casePath: saved.path,
      analysisId: analysis.id,
      mode: 'apply',
      expectedRevision: analysisRevision(changed),
      expectedFileHash: document.fileHash,
    });
    startExecutionPlan(root, plan.id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.match(getExecutionPlan(root, plan.id).error, /基线已变化/);
  });

  it('同分析版本重新关联源文件后，环境筛选不能恢复旧通过', async () => {
    const saved = await generate();
    const document = await loadCaseDocument(root, saved.path);
    document.cases[0].status = '通过';
    recordManualVerification(root, document, 0, { name: '集成', build: 'v1' });
    const old = (await caseAcceptance(root, saved.path)).environments[0].key;
    fs.writeFileSync(path.join(reqDocsDir(root), '需求.md'), '新的业务规则，分析尚未重跑');
    await linkCaseBaseline(root, {
      casePath: saved.path,
      analysisId: analysis.id,
      mode: 'apply',
      expectedFileHash: document.fileHash,
      expectedRevision: analysisRevision(analysis),
    });
    const report = await caseAcceptance(root, saved.path, old);
    assert.equal(report.passed, 0);
    assert.equal(report.pending, 1);
  });

  it('自动化计划的人工结果继承该计划环境并能完成环境验收', async () => {
    const saved = await generate();
    const document = await loadCaseDocument(root, saved.path);
    const plan = await createExecutionPlan(root, {
      casePath: saved.path,
      expectedFileHash: document.fileHash,
      caseIds: [document.cases[0].id],
      engine: 'automation',
      projectId: 'configured',
      file: 'test_api.py',
      environment: { name: 'API集成', build: 'v2' },
    });
    const file = path.join(root, '.lantern', 'local', 'case-execution', 'plans', plan.id + '.json');
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    stored.status = 'awaiting_confirmation';
    stored.items[0].externalRunId = 'external_1';
    stored.externalResult = { reportUrl: '/__tb_uiauto/report/external_1/' };
    put(file, stored);
    await verifyExecutionPlanItem(root, plan.id, {
      caseId: document.cases[0].id,
      expectedFileHash: document.fileHash,
      status: '通过',
      actualResult: '核对接口报告，返回值满足预期',
    });
    assert.equal(getExecutionPlan(root, plan.id).status, 'completed');
    const summary = await caseAcceptance(root, saved.path);
    const env = summary.environments.find((item) => item.label.includes('API集成'))!;
    assert.equal((await caseAcceptance(root, saved.path, env.key)).acceptance.ready, true);
  });

  it('确认单条结果未传缺陷编号时保留文件已有编号', async () => {
    const saved = await saveCaseDesign(root, {
      title: '缺陷编号保留',
      format: 'csv',
      headers: [...headers, '缺陷编号'],
      rows: [{ ...rows[0], 缺陷编号: 'BUG-1' }],
    });
    const document = await loadCaseDocument(root, saved.path);
    const id = '00000000-0000-4000-8000-000000000001';
    put(path.join(root, '.lantern', 'local', 'case-execution', 'runs', id + '.json'), {
      id,
      casePath: saved.path,
      caseId: document.cases[0].id,
      rowIndex: 0,
      case: document.cases[0],
      fileHash: document.fileHash,
      status: 'awaiting_confirmation',
      seq: 0,
      events: [],
      target: { url: 'https://test.example/' },
      progress: {},
      provenance: document.provenance,
    });
    await confirmRun(root, id, { status: '通过', actualResult: '用户已核验' });
    assert.equal((await loadCaseDocument(root, saved.path)).cases[0].defectNo, 'BUG-1');
  });

  it('旧文件补列需匹配预览哈希并保留原始字段，不生成备份', async () => {
    const dir = resolveContentRoot(root, '用例管理').abs;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, '旧.csv'),
      '用例编号,用例标题,测试步骤,预期结果\n1,创建,打开,成功\n',
    );
    const preview = await prepareExecutionColumns(root, { casePath: '旧.csv', mode: 'preview' });
    assert.equal(preview.preview.missingColumns.length, 2);
    await assert.rejects(
      prepareExecutionColumns(root, { casePath: '旧.csv', mode: 'apply', expectedFileHash: 'old' }),
      /已变化/,
    );
    const applied = await prepareExecutionColumns(root, {
      casePath: '旧.csv',
      mode: 'apply',
      expectedFileHash: preview.preview.fileHash,
    });
    assert.equal(applied.executable, true);
    assert.equal(applied.backup, '');
    assert.equal((await loadCaseDocument(root, '旧.csv')).cases[0].title, '创建');
  });
  it('计划只登记明确选择范围；缺自动化环境时阻塞而不标记业务用例通过', async () => {
    const saved = await generate();
    const document = await loadCaseDocument(root, saved.path);
    const plan = await createExecutionPlan(root, {
      casePath: saved.path,
      expectedFileHash: document.fileHash,
      caseIds: [document.cases[0].id],
      engine: 'automation',
      projectId: 'missing',
      file: 'api/test.py',
      environment: { name: '测试', build: 'v1' },
    });
    assert.equal(plan.status, 'draft');
    startExecutionPlan(root, plan.id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(getExecutionPlan(root, plan.id).status, 'blocked');
    assert.equal((await loadCaseDocument(root, saved.path)).cases[0].status, '待验证');
  });
});

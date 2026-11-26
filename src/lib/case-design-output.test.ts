import assert from 'node:assert/strict';
import { test } from 'node:test';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import {
  normalizeGeneratedCaseRows,
  polishCaseWorkbook,
} from '../../lh-plugins/case-design-output.mjs';
import { validateCaseDesign } from '../../lh-plugins/lh-case-design.mjs';

test('MCP 用例行按需求顺序整理，需求编号使用根需求 XQ，并补充引用需求点', () => {
  const analysis = {
    outline: [
      { id: 'RO-1', title: '需求一', quote: '编号：XQ-001 需求一' },
      { id: 'RO-1-1', title: '功能一', parentId: 'RO-1' },
      { id: 'RO-2', title: '需求二', quote: '编号：XQ-002 需求二' },
      { id: 'RO-2-1', title: '功能二', parentId: 'RO-2' },
    ],
    stories: [
      { id: 'US-001', title: '故事一', sourceRefs: ['RO-1-1'] },
      { id: 'US-002', title: '故事二', sourceRefs: ['RO-2-1'] },
    ],
    testPoints: {
      points: [
        { id: 'TP-002', storyId: 'US-002', title: '测试二' },
        { id: 'TP-001', storyId: 'US-001', title: '测试一' },
      ],
    },
  };
  const headers = [
    '用例编号',
    '需求编号',
    '模块',
    '子模块',
    '用例标题',
    '测试步骤',
    '预期结果',
    '优先级',
    '用例状态',
  ];
  const normalized = normalizeGeneratedCaseRows(
    [
      {
        用例编号: '1',
        需求编号: 'US-002',
        模块: '投诉系统',
        子模块: '错误子模块',
        用例标题: '测试二',
        测试步骤: '1、执行二',
        预期结果: '完成二',
        优先级: 'P1',
        用例状态: '待验证',
        引用需求点: 'TP-002',
      },
      {
        用例编号: '2',
        需求编号: 'US-001',
        模块: '错误系统',
        子模块: '错误子模块',
        用例标题: '测试一',
        测试步骤: '1、执行一',
        预期结果: '完成一',
        优先级: 'P0',
        用例状态: '待验证',
        引用需求点: 'TP-001',
      },
    ],
    headers,
    analysis,
    [
      { title: '需求总表', depth: 0 },
      { title: '工单系统', depth: 1 },
      { title: '需求一', depth: 2 },
      { title: 'XQ-001', depth: 3 },
      { title: '质检系统', depth: 1 },
      { title: '需求二', depth: 2 },
      { title: 'XQ-002', depth: 3 },
    ],
  );

  assert.ok(normalized.headers.includes('引用需求点'));
  assert.deepEqual(
    normalized.rows.map((row: Record<string, string>) => row['用例标题']),
    ['测试一', '测试二'],
  );
  assert.deepEqual(
    normalized.rows.map((row: Record<string, string>) => row['用例编号']),
    ['1', '2'],
  );
  assert.equal(normalized.rows[0]!['需求编号'], 'XQ-001');
  assert.equal(normalized.rows[1]!['需求编号'], 'XQ-002');
  assert.equal(normalized.rows[0]!['模块'], '工单系统');
  assert.equal(normalized.rows[0]!['子模块'], '需求一');
  assert.equal(normalized.rows[1]!['模块'], '质检系统');
  assert.equal(normalized.rows[1]!['子模块'], '需求二');
  assert.equal(normalized.rows[0]!['引用需求点'], 'RO-1-1 功能一；TP-001');
  assert.equal(normalized.rows[1]!['引用需求点'], 'RO-2-1 功能二；TP-002');
});

test('没有根需求 XQ 时需求编号写无', () => {
  const analysis = {
    outline: [
      { id: 'RO-LOCAL', title: '本地需求' },
      { id: 'RO-LOCAL-1', title: '本地功能', parentId: 'RO-LOCAL' },
    ],
    stories: [{ id: 'US-LOCAL', title: '本地故事', sourceRefs: ['RO-LOCAL-1'] }],
    testPoints: {
      points: [{ id: 'TP-LOCAL', storyId: 'US-LOCAL', title: '本地测试' }],
    },
  };
  const normalized = normalizeGeneratedCaseRows(
    [
      {
        用例编号: '1',
        需求编号: 'RO-LOCAL-1',
        用例标题: '本地测试',
        测试步骤: '1、执行',
        预期结果: '完成',
        引用需求点: 'TP-LOCAL',
      },
    ],
    ['用例编号', '需求编号', '用例标题', '测试步骤', '预期结果'],
    analysis,
  );

  assert.equal(normalized.rows[0]!['需求编号'], '无');
  assert.equal(normalized.rows[0]!['引用需求点'], 'RO-LOCAL-1 本地功能；TP-LOCAL');
});

test('MCP Excel 自动换行、自适应行高并写入优先级和状态下拉', async () => {
  const headers = ['用例编号', '用例标题', '测试步骤', '预期结果', '优先级', '用例状态'];
  const rows = [
    {
      用例编号: '1',
      用例标题: '换行与下拉',
      测试步骤: '1、打开页面\n2、提交',
      预期结果: '提交成功',
      优先级: 'P1',
      用例状态: '待验证',
    },
  ];
  const ws = XLSX.utils.json_to_sheet(rows, { header: headers });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '测试用例');
  const raw = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const polished = await polishCaseWorkbook(raw, headers);
  const zip = await JSZip.loadAsync(polished);
  const sheet = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
  const styles = await zip.file('xl/styles.xml')!.async('string');

  assert.match(styles, /wrapText="1"/);
  assert.doesNotMatch(styles, /fgColor rgb="FF000000"/);
  assert.match(sheet, /<dataValidations count="2">/);
  assert.match(
    sheet,
    /<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"\/>/,
  );
  assert.match(sheet, /sqref="E2:E1048576"/);
  assert.match(sheet, /sqref="F2:F1048576"/);
  assert.match(sheet, /"P0,P1,P2,P3"/);
  assert.match(sheet, /"待验证,通过,不通过,阻塞,跳过"/);
  assert.match(sheet, /<row r="1"[^>]*ht="30"/);
  assert.doesNotMatch(sheet, /<row r="2"[^>]*(?:ht|customHeight)=/);
});

test('功能测试校验拒绝接口模拟和性能专项场景', () => {
  const headers = ['用例编号', '需求编号', '用例标题', '前置条件', '测试步骤', '预期结果'];
  const base = {
    用例编号: '1',
    需求编号: 'XQ-001',
    用例标题: '查询页面展示结果',
    前置条件: '用户已登录',
    测试步骤: '1、点击查询',
    预期结果: '展示查询结果',
  };
  const technical = validateCaseDesign({
    caseType: 'functional',
    headers,
    rows: [{ ...base, 前置条件: '模拟查询接口超时' }],
  });
  assert.equal(technical.ok, false);
  assert.ok(technical.issues.some((issue: string) => issue.includes('接口 / 服务模拟')));

  const performance = validateCaseDesign({
    caseType: 'functional',
    headers,
    rows: [{ ...base, 测试步骤: '1、压测并发调用接口' }],
  });
  assert.equal(performance.ok, false);
  assert.ok(performance.issues.some((issue: string) => issue.includes('性能专项场景')));
});

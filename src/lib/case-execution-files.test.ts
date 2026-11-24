import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';

import {
  applyCaseFieldUpdates,
  applyCaseExecutionResult,
  listCaseDocuments,
  loadCaseDocument,
} from '../../lh-plugins/case-execution/files.mjs';

let tmp = '';
let casesRoot = '';

function xlsxBuffer() {
  const sheet = XLSX.utils.aoa_to_sheet([
    ['用例编号', '用例标题', '测试步骤', '预期结果', '用例状态', '实际结果'],
    ['TC-001', '创建工单', '1、打开页面\n2、提交', '创建成功', '待验证', ''],
  ]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, '功能测试');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lantern-case-execution-files-'));
  casesRoot = path.join(tmp, '用例管理');
  fs.mkdirSync(casesRoot, { recursive: true });
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('用例执行文件层', () => {
  it('识别执行列并把缺少状态与实际结果的文件标为不可执行', async () => {
    fs.writeFileSync(path.join(casesRoot, '功能.xlsx'), xlsxBuffer());
    fs.writeFileSync(
      path.join(casesRoot, '缺少列.md'),
      '| 用例编号 | 用例标题 | 测试步骤 | 预期结果 |\n| --- | --- | --- | --- |\n| TC-2 | 查询 | 打开页面 | 显示列表 |\n',
    );
    const files = await listCaseDocuments(tmp);
    assert.equal(files.length, 2);
    assert.equal(files.find((item) => item.name === '功能.xlsx')?.executable, true);
    const missing = files.find((item) => item.name === '缺少列.md');
    assert.equal(missing?.executable, false);
    assert.deepEqual(missing?.missingColumns, ['用例状态', '实际结果']);
  });

  it('扫描执行文件时跳过备份列表目录', async () => {
    const backupDir = path.join(casesRoot, '功能测试', '备份列表');
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, '功能_备份.xlsx'), xlsxBuffer());
    const files = await listCaseDocuments(tmp);
    assert.equal(
      files.some((item) => item.path.includes('备份列表')),
      false,
    );
  });

  it('旧版 xls 可以读取但明确标记为不可安全写回', async () => {
    const sheet = XLSX.utils.aoa_to_sheet([
      ['用例编号', '用例标题', '测试步骤', '预期结果', '用例状态', '实际结果', ''],
      ['TC-XLS', '旧版用例', '打开页面', '显示成功', '', ''],
    ]);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, '功能测试');
    fs.writeFileSync(
      path.join(casesRoot, '旧版.xls'),
      XLSX.write(book, { type: 'buffer', bookType: 'biff8' }),
    );
    const document = await loadCaseDocument(tmp, '旧版.xls');
    assert.equal(document.cases[0]?.title, '旧版用例');
    assert.equal(document.executable, false);
    assert.match(document.executionIssue, /另存为 \.xlsx/);
  });

  it('xlsx 写回目标单元格并保留原样式和其他单元格内容', async () => {
    const file = path.join(casesRoot, '功能.xlsx');
    const zip = await JSZip.loadAsync(fs.readFileSync(file));
    let xml = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
    xml = xml.replace(/<c r="E2"[^>]*\/>|<c r="E2"[^>]*>[\s\S]*?<\/c>/, '<c r="E2" s="1"/>');
    zip.file('xl/worksheets/sheet1.xml', xml);
    fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));

    const document = await loadCaseDocument(tmp, '功能.xlsx');
    assert.equal(document.executable, true);
    assert.deepEqual(
      document.cases[0]?.fields.find((field: { name: string }) => field.name === '用例编号'),
      { name: '用例编号', value: 'TC-001' },
    );
    const result = await applyCaseExecutionResult(tmp, {
      path: '功能.xlsx',
      expectedFileHash: document.fileHash,
      rowIndex: 0,
      status: '通过',
      actualResult: '工单创建成功，编号生成',
      executedAt: '2026-11-23 14:00',
    });
    assert.match(result.backup, /^备份列表\//);

    const outputZip = await JSZip.loadAsync(fs.readFileSync(file));
    const outputXml = await outputZip.file('xl/worksheets/sheet1.xml')!.async('string');
    assert.match(outputXml, /<c r="E2" s="1" t="inlineStr">/);
    assert.match(outputXml, /工单创建成功/);
    const parsed = XLSX.read(fs.readFileSync(file), { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json(parsed.Sheets['功能测试'], {
      header: 1,
      defval: '',
    }) as unknown[][];
    assert.equal(rows[1]?.[0], 'TC-001');
    assert.equal(rows[1]?.[4], '通过');
    assert.equal(rows[1]?.[5], '工单创建成功，编号生成');
  });

  it('csv 和 md 只更新目标行，表格外内容保留', async () => {
    const csv = path.join(casesRoot, '列表.csv');
    fs.writeFileSync(
      csv,
      '\uFEFF用例编号,用例标题,测试步骤,预期结果,用例状态,实际结果\r\nTC-3,列表查询,打开页面,显示列表,,,\r\n',
      'utf8',
    );
    const csvDoc = await loadCaseDocument(tmp, '列表.csv');
    await applyCaseExecutionResult(tmp, {
      path: '列表.csv',
      expectedFileHash: csvDoc.fileHash,
      rowIndex: 0,
      status: '不通过',
      actualResult: '列表为空',
    });
    const csvText = fs.readFileSync(csv, 'utf8');
    assert.match(csvText, /^\uFEFF用例编号/);
    assert.match(csvText, /TC-3,列表查询,打开页面,显示列表,不通过,列表为空/);

    const md = path.join(casesRoot, '查询.md');
    fs.writeFileSync(
      md,
      '# 查询需求\n\n| 用例编号 | 用例标题 | 测试步骤 | 预期结果 | 用例状态 | 实际结果 |\n| --- | --- | --- | --- | --- | --- |\n| TC-4 | 查询结果 | 打开页面 | 显示结果 |  |  |\n\n备注保留\n',
      'utf8',
    );
    const mdDoc = await loadCaseDocument(tmp, '查询.md');
    await applyCaseExecutionResult(tmp, {
      path: '查询.md',
      expectedFileHash: mdDoc.fileHash,
      rowIndex: 0,
      status: '通过',
      actualResult: '结果正确',
    });
    const mdText = fs.readFileSync(md, 'utf8');
    assert.match(mdText, /^# 查询需求/);
    assert.match(mdText, /TC-4 \| 查询结果/);
    assert.match(mdText, /通过/);
    assert.match(mdText, /备注保留/);
  });

  it('xlsx 存在空行时仍写回真实用例行', async () => {
    const file = path.join(casesRoot, '含空行.xlsx');
    const sheet = XLSX.utils.aoa_to_sheet([
      ['用例编号', '用例标题', '测试步骤', '预期结果', '用例状态', '实际结果'],
      [],
      ['TC-EMPTY-ROW', '空行后用例', '打开页面', '显示成功', '', ''],
    ]);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, '功能测试');
    fs.writeFileSync(file, XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));

    const document = await loadCaseDocument(tmp, '含空行.xlsx');
    assert.equal(document.cases.length, 1);
    await applyCaseExecutionResult(tmp, {
      path: '含空行.xlsx',
      expectedFileHash: document.fileHash,
      rowIndex: 0,
      status: '通过',
      actualResult: '真实行写回成功',
    });
    const parsed = XLSX.read(fs.readFileSync(file), { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json(parsed.Sheets['功能测试'], {
      header: 1,
      defval: '',
    }) as unknown[][];
    assert.equal(rows[2]?.[0], 'TC-EMPTY-ROW');
    assert.equal(rows[2]?.[4], '通过');
    assert.equal(rows[2]?.[5], '真实行写回成功');
  });

  it('文件变化后拒绝用旧结果覆盖', async () => {
    const file = path.join(casesRoot, '冲突.md');
    fs.writeFileSync(
      file,
      '| 用例编号 | 用例标题 | 测试步骤 | 预期结果 | 用例状态 | 实际结果 |\n| --- | --- | --- | --- | --- | --- |\n| TC-5 | A | 步骤 | 预期 |  |  |\n',
      'utf8',
    );
    const document = await loadCaseDocument(tmp, '冲突.md');
    fs.appendFileSync(file, '\n外部修改\n', 'utf8');
    await assert.rejects(
      applyCaseExecutionResult(tmp, {
        path: '冲突.md',
        expectedFileHash: document.fileHash,
        rowIndex: 0,
        status: '通过',
        actualResult: '不应写入',
      }),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 409,
    );
  });

  it('通用字段更新只修改文件中已存在的表头', async () => {
    const file = path.join(casesRoot, '字段更新.md');
    fs.writeFileSync(
      file,
      '| 用例编号 | 用例标题 | 测试步骤 | 预期结果 | 用例状态 | 实际结果 | 备注 |\n| --- | --- | --- | --- | --- | --- | --- |\n| TC-6 | 原标题 | 原步骤 | 原预期 |  |  | 原备注 |\n',
      'utf8',
    );
    const document = await loadCaseDocument(tmp, '字段更新.md');
    const saved = await applyCaseFieldUpdates(tmp, {
      path: '字段更新.md',
      expectedFileHash: document.fileHash,
      rowIndex: 0,
      updates: [
        { header: '用例标题', value: '修改后的标题' },
        { header: '备注', value: '自动保存备注' },
      ],
    });
    assert.match(saved.backup, /^备份列表\//);
    const updated = await loadCaseDocument(tmp, '字段更新.md');
    assert.equal(updated.cases[0]?.title, '修改后的标题');
    assert.deepEqual(
      updated.cases[0]?.fields?.find((field: { name: string }) => field.name === '备注'),
      { name: '备注', value: '自动保存备注' },
    );
    await assert.rejects(
      applyCaseFieldUpdates(tmp, {
        path: '字段更新.md',
        expectedFileHash: updated.fileHash,
        rowIndex: 0,
        updates: [{ header: '不存在的字段', value: 'x' }],
      }),
      /不存在字段/,
    );
    await applyCaseFieldUpdates(tmp, {
      path: '字段更新.md',
      expectedFileHash: updated.fileHash,
      rowIndex: 0,
      updates: [{ header: '缺陷地址', value: 'https://example.com/BUG-MD' }],
    });
    const withUrl = await loadCaseDocument(tmp, '字段更新.md');
    assert.equal(withUrl.columns.defectUrl, '缺陷信息');
    assert.equal(withUrl.cases[0]?.defectUrl, 'https://example.com/BUG-MD');
  });

  it('分类目录中的用例写回备份到同类型备份列表', async () => {
    const dir = path.join(casesRoot, '接口测试');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, '接口字段更新.md');
    fs.writeFileSync(
      file,
      '| 用例编号 | 用例标题 | 测试步骤 | 预期结果 | 用例状态 | 实际结果 | 备注 |\n| --- | --- | --- | --- | --- | --- | --- |\n| API-1 | 原接口用例 | 调用接口 | 返回成功 |  |  |  |\n',
      'utf8',
    );
    const document = await loadCaseDocument(tmp, '接口测试/接口字段更新.md');
    const saved = await applyCaseFieldUpdates(tmp, {
      path: '接口测试/接口字段更新.md',
      expectedFileHash: document.fileHash,
      rowIndex: 0,
      updates: [{ header: '备注', value: '分类备份' }],
    });
    assert.match(saved.backup, /^接口测试\/备份列表\//);
  });

  it('带备注的旧缺陷地址列校验链接，别名更新复用原列', async () => {
    fs.writeFileSync(
      path.join(casesRoot, '旧缺陷字段.md'),
      '| 用例编号 | 用例标题 | 测试步骤 | 预期结果 | 缺陷地址（多个） | 缺陷标题 |\n| --- | --- | --- | --- | --- | --- |\n| TC-OLD | 登录 | 提交 | 成功 | https://example.com/old | 旧标题 |\n',
    );
    const document = await loadCaseDocument(tmp, '旧缺陷字段.md');
    await assert.rejects(
      applyCaseFieldUpdates(tmp, {
        path: document.path,
        expectedFileHash: document.fileHash,
        rowIndex: 0,
        updates: [{ header: document.columns.defectUrl, value: 'javascript:alert(1)' }],
      }),
      /HTTP|http|链接|地址/,
    );
    await applyCaseFieldUpdates(tmp, {
      path: document.path,
      expectedFileHash: document.fileHash,
      rowIndex: 0,
      updates: [{ header: '缺陷信息', value: 'https://example.com/new' }],
    });
    const updated = await loadCaseDocument(tmp, document.path);
    assert.equal(updated.columns.defectUrl, '缺陷地址（多个）');
    assert.equal(updated.cases[0]?.defectUrl, 'https://example.com/new');
    assert.equal(updated.headers.includes('缺陷信息'), false);
  });

  it('缺少缺陷信息和缺陷标题列时自动追加并写入', async () => {
    const file = path.join(casesRoot, '新增缺陷信息.xlsx');
    const sheet = XLSX.utils.aoa_to_sheet([
      ['用例编号', '用例标题', '测试步骤', '预期结果', '用例状态', '实际结果'],
      ['TC-URL', '失败用例', '打开页面', '显示成功', '不通过', '页面报错'],
    ]);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, '功能测试');
    fs.writeFileSync(file, XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
    const document = await loadCaseDocument(tmp, '新增缺陷信息.xlsx');
    assert.equal(document.columns.defectUrl, '');
    assert.equal(document.columns.defectTitle, '');
    await applyCaseFieldUpdates(tmp, {
      path: '新增缺陷信息.xlsx',
      expectedFileHash: document.fileHash,
      rowIndex: 0,
      updates: [
        { header: '缺陷标题', value: '登录页提交后无响应' },
        { header: '缺陷地址', value: 'https://jira.example.com/browse/BUG-1' },
      ],
    });
    const updated = await loadCaseDocument(tmp, '新增缺陷信息.xlsx');
    assert.equal(updated.columns.defectUrl, '缺陷信息');
    assert.equal(updated.columns.defectTitle, '缺陷标题');
    assert.equal(updated.cases[0]?.defectTitle, '登录页提交后无响应');
    assert.equal(updated.cases[0]?.defectUrl, 'https://jira.example.com/browse/BUG-1');
  });
});

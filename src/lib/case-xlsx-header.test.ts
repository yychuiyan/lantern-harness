/**
 * xlsx 跨工作表挑用例表头：首 sheet 是「说明」时不应把标题行当成字段。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as XLSX from 'xlsx';

import { parseXlsxCaseRows, pickCaseXlsxTable, scoreCaseHeaderRow } from './case-file';
import { parseXlsxTemplateBase64 } from './case-template';

function bookToBase64(book: XLSX.WorkBook): string {
  return XLSX.write(book, { type: 'base64', bookType: 'xlsx' });
}

describe('xlsx 用例表头识别', () => {
  it('单格长标题不得分；真实字段行得分高', () => {
    assert.equal(scoreCaseHeaderRow(['上海12345市民服务热线 V1.11 功能测试用例']), 0);
    assert.ok(
      scoreCaseHeaderRow([
        '用例编号',
        '需求编号',
        '测试项目',
        '测试分项目',
        '预置条件',
        '测试步骤',
        '期望内容标准',
      ]) > 40,
    );
  });

  it('第一个工作表是说明时，仍取「功能测试用例」表头', () => {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      book,
      XLSX.utils.aoa_to_sheet([
        ['上海12345市民服务热线 V1.11 功能测试用例'],
        [],
        ['依据', '需求规格说明书'],
        ['字段', '用例编号、测试分项目…'],
      ]),
      '说明',
    );
    XLSX.utils.book_append_sheet(
      book,
      XLSX.utils.aoa_to_sheet([
        ['用例编号', '需求编号', '测试项目', '测试分项目', '预置条件', '测试步骤', '期望内容标准'],
        ['TC-01', 'XQ-1', '工单系统', '退单处理', '已登录', '1、打开页面', '1、可操作'],
      ]),
      '功能测试用例',
    );

    const picked = pickCaseXlsxTable(book);
    assert.ok(picked);
    assert.equal(picked!.sheetName, '功能测试用例');
    assert.deepEqual(picked!.usedHeaders, [
      '用例编号',
      '需求编号',
      '测试项目',
      '测试分项目',
      '预置条件',
      '测试步骤',
      '期望内容标准',
    ]);

    const b64 = bookToBase64(book);
    const tpl = parseXlsxTemplateBase64(b64);
    assert.ok(tpl.headers.includes('测试分项目'));
    assert.equal(tpl.headers.includes('上海12345市民服务热线 V1.11 功能测试用例'), false);

    const rows = parseXlsxCaseRows(b64);
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0]!['测试分项目'], '退单处理');
  });

  it('单 sheet 且第一行就是表头时行为不变', () => {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      book,
      XLSX.utils.aoa_to_sheet([
        ['用例编号', '用例标题', '测试步骤', '预期结果'],
        ['1', '登录', '打开', '成功'],
      ]),
      'Sheet1',
    );
    const tpl = parseXlsxTemplateBase64(bookToBase64(book));
    assert.deepEqual(tpl.headers, ['用例编号', '用例标题', '测试步骤', '预期结果']);
  });
});

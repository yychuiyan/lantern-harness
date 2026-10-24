/**
 * 用例 xlsx 抛光：下拉校验节点顺序必须合法，否则 Excel 弹「部分内容有问题」。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import JSZip from 'jszip';
import { rowsToXlsxBase64 } from './case-template';

describe('rowsToXlsxBase64 polish', () => {
  it('dataValidations 在 ignoredErrors 之前', async () => {
    const headers = ['用例编号', '用例标题', '实际结果', '优先级', '用例状态'];
    const b64 = await rowsToXlsxBase64(
      [{ 用例编号: '1', 用例标题: '示例', 实际结果: '', 优先级: 'P1', 用例状态: '待验证' }],
      headers,
    );
    const zip = await JSZip.loadAsync(b64, { base64: true });
    const sheet = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
    const styles = await zip.file('xl/styles.xml')!.async('string');
    const iDv = sheet.indexOf('<dataValidations');
    const iIgn = sheet.indexOf('<ignoredErrors');
    assert.ok(iDv >= 0, '应写入 dataValidations');
    assert.ok(iIgn < 0 || iDv < iIgn, 'dataValidations 必须在 ignoredErrors 之前');
    assert.equal(styles.includes('<!--'), false, 'styles 不应再留 XML 注释标记');
    assert.match(sheet, /sqref="C2:C1048576"/);
    assert.match(sheet, /待验证,通过,不通过,阻塞,跳过/);
  });
});

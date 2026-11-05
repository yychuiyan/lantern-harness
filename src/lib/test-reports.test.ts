import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { kindFromReportPath, TEST_REPORT_KINDS } from './test-reports';

describe('test-reports', () => {
  it('三类目录齐全', () => {
    assert.equal(TEST_REPORT_KINDS.length, 3);
    assert.deepEqual(
      TEST_REPORT_KINDS.map((k) => k.folder),
      ['功能测试报告', '接口测试报告', '性能测试报告'],
    );
  });

  it('从路径推断报告类型', () => {
    assert.equal(kindFromReportPath('功能测试报告/a.md'), 'functional');
    assert.equal(kindFromReportPath('接口测试报告/x.md'), 'api');
    assert.equal(kindFromReportPath('性能测试报告/y.md'), 'perf');
    assert.equal(kindFromReportPath('其它/z.md'), null);
    assert.equal(kindFromReportPath(''), null);
  });
});

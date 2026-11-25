import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';

import {
  kindFromReportPath,
  kindFromSlug,
  reportFileKind,
  TEST_REPORT_KINDS,
  TEST_REPORT_PROMPT_SEEDS,
} from './test-reports';

describe('test-reports', () => {
  it('三类目录齐全', () => {
    assert.equal(TEST_REPORT_KINDS.length, 3);
    assert.deepEqual(
      TEST_REPORT_KINDS.map((k) => k.folder),
      ['功能测试报告', '接口测试报告', '性能测试报告'],
    );
    assert.deepEqual(
      TEST_REPORT_KINDS.map((k) => k.slug),
      ['functional', 'api', 'performance'],
    );
  });

  it('从路径推断报告类型', () => {
    assert.equal(kindFromReportPath('功能测试报告/a.md'), 'functional');
    assert.equal(kindFromReportPath('接口测试报告/x.md'), 'api');
    assert.equal(kindFromReportPath('性能测试报告/y.md'), 'perf');
    assert.equal(kindFromReportPath('其它/z.md'), null);
    assert.equal(kindFromReportPath(''), null);
  });

  it('页面 slug 与报告类型一一对应', () => {
    assert.equal(kindFromSlug('functional'), 'functional');
    assert.equal(kindFromSlug('api'), 'api');
    assert.equal(kindFromSlug('performance'), 'perf');
    assert.equal(kindFromSlug('other'), null);
  });

  it('报告类型筛选按扩展名归类且大小写无关', () => {
    assert.equal(reportFileKind('功能测试.docx'), 'word');
    assert.equal(reportFileKind('性能结果.XLSX'), 'excel');
    assert.equal(reportFileKind('场景.md'), 'text');
    assert.equal(reportFileKind('结果.csv'), 'csv');
    assert.equal(reportFileKind('截图.png'), 'other');
    assert.equal(reportFileKind('无扩展名'), 'other');
  });

  it('三类技能种子使用各自的业务口径', () => {
    const seeds = TEST_REPORT_KINDS.map((kind) => TEST_REPORT_PROMPT_SEEDS[kind.id]);
    assert.equal(new Set(seeds).size, 3);
    assert.match(TEST_REPORT_PROMPT_SEEDS.functional, /通过率/);
    assert.match(TEST_REPORT_PROMPT_SEEDS.functional, /P0 \/ P1/);
    assert.match(TEST_REPORT_PROMPT_SEEDS.api, /接口覆盖/);
    assert.match(TEST_REPORT_PROMPT_SEEDS.api, /状态码|断言/);
    assert.match(TEST_REPORT_PROMPT_SEEDS.perf, /TPS \/ QPS/);
    assert.match(TEST_REPORT_PROMPT_SEEDS.perf, /P95 \/ P99/);
  });

  it('随包技能种子与运行时种子保持一致', () => {
    for (const kind of TEST_REPORT_KINDS) {
      const file = new URL(`../../config/seeds/提示词管理/${kind.defaultPrompt}`, import.meta.url);
      assert.equal(fs.readFileSync(file, 'utf8').trim(), TEST_REPORT_PROMPT_SEEDS[kind.id].trim());
    }
  });
});

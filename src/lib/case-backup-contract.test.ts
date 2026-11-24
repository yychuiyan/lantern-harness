import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  backupDirectoryForCasePath,
  caseTypeFolderForPath,
  isCaseBackupPath,
} from '../../builtin/case-backup-contract.mjs';

describe('用例备份分类路径', () => {
  it('按源用例的第一级类型目录放置备份', () => {
    assert.equal(backupDirectoryForCasePath('接口测试/登录.xlsx'), '接口测试/备份列表');
    assert.equal(backupDirectoryForCasePath('功能测试/子目录/登录.xlsx'), '功能测试/备份列表');
    assert.equal(backupDirectoryForCasePath('根目录历史用例.xlsx'), '备份列表');
  });

  it('识别任意层级的备份列表并拒绝再次备份备份文件', () => {
    assert.equal(caseTypeFolderForPath('性能测试/用例.xlsx'), '性能测试');
    assert.equal(caseTypeFolderForPath('性能测试/备份列表/用例.xlsx'), '');
    assert.equal(isCaseBackupPath('功能测试/备份列表/a.xlsx'), true);
    assert.equal(isCaseBackupPath('功能测试/a.xlsx'), false);
  });
});

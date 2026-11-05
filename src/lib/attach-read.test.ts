/**
 * 附件读取：.doc 走本地服务抽正文。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';

import { extractAttachText } from '../../lh-plugins/lh-attach.mjs';

describe('extractAttachText (.doc)', () => {
  it('从旧版 Word 抽出正文', async () => {
    const file = '/Users/zhanghaoju/Downloads/上海12345市民服务热线V1.12版本_测试用例_副本.doc';
    if (!fs.existsSync(file)) {
      // 本机无样例时跳过，不挡 CI
      return;
    }
    const buf = fs.readFileSync(file);
    const text = await extractAttachText(buf, '样例.doc');
    assert.match(text, /# 样例\.doc/);
    assert.ok(text.length > 80);
    assert.match(text, /测试用例|系统|功能/);
  });

  it('非 Word 扩展名报错', async () => {
    await assert.rejects(() => extractAttachText(Buffer.from('x'), 'a.pdf'), /暂不支持/);
  });
});

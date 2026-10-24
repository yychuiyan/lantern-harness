import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { enhanceMarkdownTableCells } from './markdown-client';

describe('markdown-client table cells', () => {
  it('enhanceMarkdownTableCells wraps td/th with chat-md-cell and data-hint', () => {
    // jsdom / happy-dom 未接入时跳过（本仓库 node:test 默认无 DOMParser）
    if (typeof DOMParser === 'undefined') {
      const raw = '<table><tr><td>hello</td></tr></table>';
      assert.equal(enhanceMarkdownTableCells(raw), raw);
      return;
    }
    const html = enhanceMarkdownTableCells(
      '<table><thead><tr><th>标题</th></tr></thead><tbody><tr><td>1. 一步<br>2. 二步</td></tr></tbody></table>',
    );
    assert.match(html, /class="chat-md-cell"/);
    assert.match(html, /data-hint-fit/);
    assert.match(html, /data-hint="[^"]*1\. 一步/);
    assert.match(html, /chat-md-table-scroll/);
  });
});

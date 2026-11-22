import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { collectPages } from '../../lh-plugins/business-map/sources.mjs';

describe('业务地图页面真实只读采集', () => {
  let server: http.Server,
    base = '',
    root = '',
    writes = 0;
  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-browser-'));
    server = http.createServer((req, res) => {
      if (req.method === 'POST' || req.url?.includes('/delete')) writes++;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (req.url === '/detail')
        return res.end(
          '<html><title>报销详情</title><body><h1>报销详情</h1><p>申请人、金额、凭证和财务审核状态</p></body></html>',
        );
      if (req.url === '/login')
        return res.end('<html><body><input type="password" /></body></html>');
      res.end(
        `<html><title>财务管理</title><body><h1>费用报销</h1><a href="/detail">报销详情</a><a href="/delete?id=1">删除申请</a><button onclick="fetch('/write',{method:'POST'})">提交审批</button><button role="tab" onclick="document.getElementById('panel').textContent='历史凭证记录'">凭证记录</button><div id="panel">报销列表</div><script>fetch('/write',{method:'POST'}).catch(()=>{});fetch('/api/delete?id=1').catch(()=>{});</script></body></html>`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const config = () => ({
    sources: { page: { enabled: true } },
    scope: { mode: 'system', targets: [] },
    entryUrl: base,
    pageUrls: [],
    maxPages: 5,
    maxDepth: 2,
  });
  it('采集列表、详情和标签，拦截脚本写请求与危险 GET 入口', async () => {
    const result = await collectPages(
      root,
      { entryUrl: base, sourceDir: '', loginState: '' },
      config(),
      { signal: new AbortController().signal, onProgress: () => {} },
    );
    assert.equal(writes, 0);
    assert.ok(
      result.evidence.some((item: { content: string }) => item.content.includes('财务审核状态')),
    );
    assert.ok(
      result.evidence.some((item: { content: string }) => item.content.includes('历史凭证记录')),
    );
    assert.ok(result.issues.some((item: string) => item.includes('只读拦截：POST')));
    assert.ok(result.issues.some((item: string) => item.includes('只读拦截：GET')));
  });
  it('登录页面记录为失败来源，不把密码表单当业务功能证据', async () => {
    const result = await collectPages(
      root,
      { entryUrl: base + '/login', sourceDir: '', loginState: '' },
      { ...config(), entryUrl: base + '/login' },
      { signal: new AbortController().signal, onProgress: () => {} },
    );
    assert.equal(result.evidence.length, 0);
    assert.ok(result.issues.some((item: string) => item.includes('登录态失效')));
  });
});

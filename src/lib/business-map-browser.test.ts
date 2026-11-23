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
      if (req.url === '/app/')
        return res.end(
          '<html><body><div>正在前往工单系统</div><script>setTimeout(()=>{document.body.innerHTML="<h1>工单工作台</h1><p>工单查询与受理</p>"},200)</script></body></html>',
        );
      if (req.url === '/nested-menu')
        return res.end(
          '<html><title>业务菜单</title><body><h1>业务工作台</h1><div role="tree"><div role="treeitem" aria-label="业务受理"><span>业务受理</span><div role="treeitem" aria-label="新建工单"><button>新建工单</button></div></div></div></body></html>',
        );
      if (req.url === '/custom-menu')
        return res.end(
          '<html><head><style>.menu-panel{position:fixed;left:0;top:0;width:240px;height:520px;background:#fff}.menu-row{display:flex;align-items:center;height:36px;padding-left:12px;cursor:pointer}.sub{padding-left:34px}</style></head><body><aside class="menu-panel"><div class="menu-row">首页</div><div class="menu-row">工单查询</div><div class="menu-row">工单受理</div><div class="menu-row sub">新建工单</div><div class="menu-row">派单处理</div></aside><main><h1>工单系统</h1><p>工单查询与受理</p></main></body></html>',
        );
      res.end(
        `<html><title>财务管理</title><body><h1>费用报销</h1><a href="/detail">报销详情</a><a href="/delete?id=1">删除申请</a><button onclick="fetch('/write',{method:'POST'})">提交审批</button><button role="tab" onclick="document.getElementById('panel').textContent='历史凭证记录'">凭证记录</button><div id="panel">报销列表</div><script>localStorage.setItem('modulesConfigs',JSON.stringify([{id:'module-app',name:'工单系统',url:'/app'}]));fetch('/write',{method:'POST'}).catch(()=>{});fetch('/api/delete?id=1').catch(()=>{});</script></body></html>`,
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
    assert.ok(
      result.pages.some(
        (item: { title?: string; status?: string; source?: string }) =>
          item.title === '报销详情' && item.status === 'success' && item.source === 'link',
      ),
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
  it('门户 modulesConfigs 可为子系统补齐 moduleid 后继续采集', async () => {
    const result = await collectPages(
      root,
      { entryUrl: base + '/app/', sourceDir: '', loginState: '' },
      { ...config(), entryUrl: base + '/app/', maxPages: 1 },
      { signal: new AbortController().signal, onProgress: () => {} },
    );
    assert.equal(result.evidence.length, 1);
    assert.match(result.evidence[0].content, /工单查询与受理/);
    assert.equal(result.pages[0].status, 'success');
  });
  it('只采集已选页面时不再从系统入口遍历整站', async () => {
    const result = await collectPages(
      root,
      { entryUrl: base, sourceDir: '', loginState: '' },
      {
        ...config(),
        pageUrls: [base + '/detail'],
        selectedPagesOnly: true,
        maxDepth: 5,
      },
      { signal: new AbortController().signal, onProgress: () => {} },
    );
    assert.equal(result.evidence.length, 1);
    assert.match(result.evidence[0].content, /财务审核状态/);
    assert.equal(result.pages.length, 1);
    assert.equal(result.pages[0].title, '报销详情');
    assert.ok(
      !result.evidence.some((item: { content: string }) => item.content.includes('费用报销')),
    );
  });
  it('嵌套 SPA 菜单保留完整 menuPath', async () => {
    const result = await collectPages(
      root,
      { entryUrl: base + '/nested-menu', sourceDir: '', loginState: '' },
      {
        ...config(),
        entryUrl: base + '/nested-menu',
        maxPages: 5,
      },
      { signal: new AbortController().signal, onProgress: () => {} },
    );
    const menu = result.pages.find(
      (item: { menuPath?: string[] }) =>
        item.menuPath?.includes('业务受理') && item.menuPath?.includes('新建工单'),
    );
    assert.ok(menu);
    assert.deepEqual(menu.menuPath, ['业务受理', '新建工单']);
    assert.equal(menu.actionable, true);
  });
  it('自定义 SPA 侧边菜单按 DOM 顺序和缩进层级生成菜单清单', async () => {
    const result = await collectPages(
      root,
      { entryUrl: base + '/custom-menu', sourceDir: '', loginState: '' },
      {
        ...config(),
        entryUrl: base + '/custom-menu',
        maxPages: 2,
      },
      { signal: new AbortController().signal, onProgress: () => {} },
    );
    assert.deepEqual(
      result.navigation.map((item: { label: string }) => item.label),
      ['首页', '工单查询', '工单受理', '新建工单', '派单处理'],
    );
    assert.deepEqual(result.navigation[3].path, ['工单受理', '新建工单']);
    assert.deepEqual(
      result.navigation.map((item: { order: number }) => item.order),
      [0, 1, 2, 3, 4],
    );
  });
});

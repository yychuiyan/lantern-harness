import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import JSZip from 'jszip';

import {
  collectFiles,
  collectOnlineDocuments,
  saveBusinessMaterial,
} from '../../lh-plugins/business-map/sources.mjs';

const roots: string[] = [];
const servers: http.Server[] = [];

after(() => {
  for (const server of servers) server.close();
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-sources-'));
  roots.push(root);
  return root;
}

async function xmindBuffer() {
  const zip = new JSZip();
  zip.file(
    'content.json',
    JSON.stringify([
      {
        rootTopic: {
          title: '工单业务',
          children: {
            attached: [{ title: '受理' }, { title: '派单' }, { title: '归档' }],
          },
        },
      },
    ]),
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('业务地图扩展取证来源', () => {
  it('读取 Markdown、XMind 与当前业务流程', async () => {
    const root = tempRoot();
    const systemId = 'sys_sources';
    saveBusinessMaterial(root, systemId, '业务说明.md', Buffer.from('# 说明\n审批通过后生成工单'));
    saveBusinessMaterial(root, systemId, '业务脑图.xmind', await xmindBuffer());
    const system = {
      id: systemId,
      name: '工单系统',
      entryUrl: 'https://example.com',
      sourceDir: '',
      functions: [],
      flows: [
        {
          id: 'flow_1',
          name: '工单受理',
          result: '工单进入待派单',
          status: '健康',
          steps: [
            {
              id: 'step_1',
              title: '提交工单',
              role: '市民',
              system: '工单系统',
              functionId: 'fn_1',
              input: '诉求',
              output: '工单',
              next: '',
              branch: '',
              dependencies: [],
              branchBroken: false,
              manual: false,
            },
          ],
        },
      ],
    };
    const result = await collectFiles(
      root,
      system,
      {
        sources: {
          page: { enabled: false },
          onlineDoc: { enabled: false },
          process: { enabled: true },
          doc: { enabled: false },
          material: { enabled: true },
          code: { enabled: false },
        },
        materials: ['业务说明.md', '业务脑图.xmind'],
      },
      { signal: new AbortController().signal, onProgress: () => {} },
    );
    assert.ok(result.evidence.some((item) => item.type === 'process'));
    const material = result.evidence.filter((item) => item.type === 'material');
    assert.ok(material.some((item) => item.content.includes('审批通过后生成工单')));
    assert.ok(material.some((item) => item.content.includes('工单业务')));
    assert.ok(material.some((item) => item.content.includes('受理')));
  });

  it('读取用户指定的在线文档正文', async () => {
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(
        '<html><head><title>在线业务说明</title></head><body><main>客户提交需求后进入审核队列</main></body></html>',
      );
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const base = `http://127.0.0.1:${address.port}`;
    const result = await collectOnlineDocuments(
      tempRoot(),
      { id: 'sys_online', entryUrl: base, sourceDir: '', loginState: '' },
      {
        sources: {
          page: { enabled: false },
          onlineDoc: { enabled: true },
          process: { enabled: false },
          doc: { enabled: false },
          material: { enabled: false },
          code: { enabled: false },
        },
        onlineDocUrls: [base + '/doc'],
      },
      { signal: new AbortController().signal, onProgress: () => {} },
    );
    assert.equal(result.evidence.length, 1);
    assert.equal(result.evidence[0]?.type, 'online_doc');
    assert.match(result.evidence[0]?.content || '', /客户提交需求后进入审核队列/);
  });
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  assistantDir,
  createBusinessAssistantService,
} from '../../lh-plugins/business-map/assistant.mjs';

const system = {
  id: 'sys_assistant',
  name: '助手测试系统',
  description: '测试 AI 会话',
  entryUrl: 'https://example.com',
  sourceDir: '',
  directories: [],
  functions: [],
  flows: [],
};

const settings = {
  baseURL: 'https://model.example/v1',
  model: 'fake-model',
  apiKey: 'SECRET_NOT_PERSISTED',
};

async function waitFor(
  service: ReturnType<typeof createBusinessAssistantService>,
  root: string,
  status: string,
) {
  for (let index = 0; index < 100; index += 1) {
    const session = service.get(root, system);
    if (session.status === status) return session;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`会话没有进入 ${status}`);
}

afterEach(() => {
  // Each test owns and removes its temp directory in its body.
});

describe('业务地图持久化 AI 会话', () => {
  it('第一阶段使用页面证据生成目录草案并在应用后开放流程', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-assistant-'));
    const appliedRevisions: number[] = [];
    const service = createBusinessAssistantService({
      pages: async () => ({
        pages: [
          {
            id: 'pg_1',
            title: '新建工单',
            url: 'https://example.com/new',
            menuPath: ['工单受理', '新建工单'],
          },
        ],
        evidence: [
          {
            id: 'src_page',
            type: 'page',
            title: '新建工单',
            ref: 'https://example.com/new',
            content: '新建工单页面用于登记诉求并提交工单',
          },
        ],
        issues: [],
      }),
      applyDirectoryProposal: (
        _root: string,
        _systemId: string,
        proposal: unknown,
        revision: number,
      ) => {
        appliedRevisions.push(revision);
        return {
          store: { revision: revision + 1, systems: [] },
          applied: { directories: 1, functions: 1, flows: 0 },
        };
      },
      applyFlowProposal: (
        _root: string,
        _systemId: string,
        proposal: { flows: unknown[] },
        revision: number,
      ) => ({
        store: { revision: revision + 1, systems: [] },
        applied: { directories: 0, functions: 0, flows: proposal.flows.length },
      }),
      model: async () => ({
        value: {
          message: '已识别工单受理目录。',
          directories: [
            {
              key: 'd1',
              parentKey: '',
              name: '工单受理',
              menuPath: ['工单受理'],
            },
          ],
          functions: [
            {
              name: '新建工单',
              directoryKey: 'd1',
              purpose: '登记诉求并提交工单',
              entry: '/new',
              menuPath: ['工单受理', '新建工单'],
              evidence: [
                {
                  sourceId: 'src_page',
                  quote: '新建工单页面用于登记诉求并提交工单',
                },
              ],
            },
          ],
          warnings: [],
        },
        usage: { total_tokens: 10 },
      }),
    });
    try {
      assert.throws(
        () => service.start(root, system, { phase: 'flow', message: '识别流程' }, settings),
        /先识别并应用功能目录/,
      );
      service.start(root, system, { phase: 'directory', message: '识别功能目录' }, settings);
      const ready = await waitFor(service, root, 'awaiting_confirmation');
      assert.equal(ready.proposal?.kind, 'directory');
      assert.equal(ready.proposal?.functions.length, 1);
      assert.ok(ready.events.some((event: { title: string }) => event.title === 'scan_navigation'));
      const saved = fs.readFileSync(
        path.join(root, '.lantern', 'local', 'business-map', 'assistant', `${system.id}.json`),
        'utf8',
      );
      assert.ok(!saved.includes(settings.apiKey));

      const result = await service.apply(root, system, { revision: 1 });
      assert.equal(result.session.directoryApplied, true);
      assert.equal(result.session.phase, 'flow');
      assert.equal(appliedRevisions[0], 1);
    } finally {
      service.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('使用真实菜单清单补齐目录并保持菜单顺序', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-assistant-menu-'));
    const service = createBusinessAssistantService({
      pages: async () => ({
        pages: [
          {
            id: 'pg_menu',
            title: '工单系统',
            url: 'https://example.com',
          },
        ],
        evidence: [
          {
            id: 'src_menu',
            type: 'page',
            title: '工单系统',
            ref: 'https://example.com',
            content: '首页、工单查询、工单受理、新建工单和派单处理',
          },
        ],
        issues: [],
        navigation: [
          { label: '首页', path: ['首页'], depth: 0, order: 0 },
          { label: '工单查询', path: ['工单查询'], depth: 0, order: 1 },
          { label: '工单受理', path: ['工单受理'], depth: 0, order: 2 },
          { label: '新建工单', path: ['工单受理', '新建工单'], depth: 1, order: 3 },
          { label: '派单处理', path: ['派单处理'], depth: 0, order: 4 },
        ],
      }),
      applyDirectoryProposal: () => ({ store: {}, applied: {} }),
      applyFlowProposal: () => ({ store: {}, applied: {} }),
      model: async () => ({
        value: {
          message: '目录草案',
          directories: [
            { key: 'd1', parentKey: '', name: '首页', menuPath: ['首页'] },
            { key: 'd2', parentKey: '', name: '工单受理', menuPath: ['工单受理'] },
          ],
          functions: [
            {
              name: '新建工单',
              directoryKey: 'd2',
              purpose: '登记工单',
              entry: 'https://example.com/new',
              menuPath: ['工单受理', '新建工单'],
              evidence: [{ sourceId: 'src_menu', quote: '新建工单和派单处理' }],
            },
          ],
          warnings: [],
        },
        usage: {},
      }),
    });
    try {
      service.start(root, system, { phase: 'directory', message: '识别菜单' }, settings);
      const ready = await waitFor(service, root, 'awaiting_confirmation');
      assert.deepEqual(
        ready.proposal?.directories.map((directory: { name: string }) => directory.name),
        ['首页', '工单查询', '工单受理', '新建工单', '派单处理'],
      );
      assert.deepEqual(ready.proposal?.directories[3].menuPath, ['工单受理', '新建工单']);
      assert.ok(
        ready.proposal?.warnings.some((warning: string) => warning.includes('真实系统菜单补充')),
      );
    } finally {
      service.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('服务重启后保留历史并把运行中会话标记为中断', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-assistant-restart-'));
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = createBusinessAssistantService({
      pages: async () => {
        await gate;
        return { pages: [], evidence: [], issues: [] };
      },
      applyDirectoryProposal: () => ({ store: {}, applied: {} }),
      applyFlowProposal: () => ({ store: {}, applied: {} }),
      model: async () => ({ value: {}, usage: {} }),
    });
    try {
      first.start(root, system, { phase: 'directory', message: '开始识别' }, settings);
      await new Promise((resolve) => setTimeout(resolve, 20));
      first.close();
      release();

      const second = createBusinessAssistantService({
        pages: async () => ({ pages: [], evidence: [], issues: [] }),
        applyDirectoryProposal: () => ({ store: {}, applied: {} }),
        applyFlowProposal: () => ({ store: {}, applied: {} }),
        model: async () => ({ value: {}, usage: {} }),
      });
      try {
        const session = second.get(root, system);
        assert.equal(session.status, 'interrupted');
        assert.ok(session.messages.some((message: { role: string }) => message.role === 'user'));
        assert.ok(session.events.length > 0);
      } finally {
        second.close();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('模型长时间无响应时持续推送等待进度并超时停止', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-assistant-timeout-'));
    const service = createBusinessAssistantService({
      pages: async () => ({
        pages: [
          {
            id: 'pg_timeout',
            title: '超时测试页',
            url: 'https://example.com/timeout',
          },
        ],
        evidence: [
          {
            id: 'src_timeout',
            type: 'page',
            title: '超时测试页',
            ref: 'https://example.com/timeout',
            content: '用于测试模型超时的页面正文',
          },
        ],
        issues: [],
      }),
      applyDirectoryProposal: () => ({ store: {}, applied: {} }),
      applyFlowProposal: () => ({ store: {}, applied: {} }),
      model: async (_settings: unknown, _messages: unknown, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            {
              once: true,
            },
          );
        }),
      modelTimeoutMs: 40,
      modelHeartbeatMs: 8,
    });
    try {
      service.start(root, system, { phase: 'directory', message: '测试模型超时' }, settings);
      const failed = await waitFor(service, root, 'error');
      assert.equal(failed.status, 'error');
      assert.ok(
        failed.events.some((event: { title: string }) =>
          event.title.includes('模型正在生成识别草案（已等待'),
        ),
      );
      assert.ok(
        failed.events.some((event: { detail?: string }) => event.detail?.includes('秒内没有响应')),
      );
      assert.equal(failed.fallback?.available, true);
      assert.equal(failed.fallback?.recommendedAction, 'client_fallback');
      assert.ok(failed.fallback?.promptChars > 0);
      const fallback = service.context(root, system, { maxChars: 10_000 });
      assert.equal(fallback.fallback.canGenerateDirectory, true);
      assert.equal(fallback.sources[0].sourceId, 'src_timeout');
      assert.match(fallback.sources[0].content, /模型超时/);
    } finally {
      service.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('检测到登录页时让已保存登录态失效', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-assistant-login-expired-'));
    let invalidated = 0;
    const service = createBusinessAssistantService({
      pages: async () => ({
        pages: [],
        evidence: [],
        navigation: [],
        issues: ['登录态失效：检测到登录页面，请更新登录态后重试'],
      }),
      applyDirectoryProposal: () => ({ store: {}, applied: {} }),
      applyFlowProposal: () => ({ store: {}, applied: {} }),
      invalidateLogin: async () => {
        invalidated += 1;
      },
      model: async () => ({ value: {}, usage: {} }),
    });
    try {
      service.start(root, system, { phase: 'directory', message: '测试登录失效' }, settings);
      const failed = await waitFor(service, root, 'error');
      assert.equal(invalidated, 1);
      assert.equal(failed.fallback?.available, false);
      assert.equal(failed.fallback?.recommendedAction, 'retry_login');
      const fallback = service.context(root, system);
      assert.equal(fallback.fallback.available, false);
      assert.equal(fallback.fallback.canGenerateDirectory, false);
      assert.deepEqual(fallback.sources, []);
    } finally {
      service.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('旧 codex_fallback 会话值兼容映射为 client_fallback', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-assistant-legacy-fallback-'));
    const service = createBusinessAssistantService({
      pages: async () => ({ pages: [], evidence: [], issues: [] }),
      applyDirectoryProposal: () => ({ store: {}, applied: {} }),
      applyFlowProposal: () => ({ store: {}, applied: {} }),
      model: async () => ({ value: {}, usage: {} }),
    });
    try {
      const file = path.join(assistantDir(root), `${system.id}.json`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        JSON.stringify({
          version: 1,
          systemId: system.id,
          phase: 'directory',
          status: 'error',
          runId: '',
          seq: 1,
          messages: [],
          events: [],
          progress: { label: '失败', current: 0, total: 0, percent: 0 },
          proposal: null,
          fallback: {
            available: true,
            recommendedAction: 'codex_fallback',
            reason: '旧值',
            pageCount: 1,
            menuCount: 1,
            evidenceCount: 1,
            sourceChars: 10,
            promptChars: 100,
            promptApproxTokens: 34,
            model: 'legacy-model',
            issues: [],
            updatedAt: '2026-11-24T00:00:00.000Z',
          },
          directoryApplied: false,
          flowApplied: false,
        }),
      );
      assert.equal(service.get(root, system).fallback?.recommendedAction, 'client_fallback');
    } finally {
      service.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('模型返回空草案时进入调用方兜底而不是等待空结果确认', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-assistant-empty-'));
    const service = createBusinessAssistantService({
      pages: async () => ({
        pages: [{ id: 'pg_empty', title: '新建工单', url: 'https://example.com/new' }],
        evidence: [
          {
            id: 'src_empty',
            type: 'page',
            title: '新建工单',
            ref: 'https://example.com/new',
            content: '新建工单页面用于登记诉求',
          },
        ],
        navigation: [{ label: '工单受理', path: ['工单受理'], order: 0 }],
        issues: [],
      }),
      applyDirectoryProposal: () => ({ store: {}, applied: {} }),
      applyFlowProposal: () => ({ store: {}, applied: {} }),
      model: async () => ({
        value: { message: '没有可用功能', directories: [], functions: [], warnings: [] },
        usage: {},
      }),
    });
    try {
      service.start(root, system, { phase: 'directory', message: '测试空草案' }, settings);
      const failed = await waitFor(service, root, 'error');
      assert.equal(failed.proposal, null);
      assert.equal(failed.fallback?.available, true);
      assert.equal(failed.fallback?.recommendedAction, 'client_fallback');
      assert.ok(
        failed.events.some((event: { detail?: string }) =>
          event.detail?.includes('模型没有生成带有效证据的功能'),
        ),
      );
    } finally {
      service.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('模型上下文会去掉多页重复导航，只保留页面特定内容', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-assistant-compact-'));
    let prompt = '';
    const service = createBusinessAssistantService({
      pages: async () => ({
        pages: [
          { id: 'pg_1', title: '新建工单', url: 'https://example.com/new' },
          { id: 'pg_2', title: '派单处理', url: 'https://example.com/dispatch' },
          { id: 'pg_3', title: '退单处理', url: 'https://example.com/return' },
        ],
        evidence: [
          {
            id: 'src_1',
            type: 'page',
            title: '新建工单',
            ref: 'https://example.com/new',
            content: '公共左侧导航\n新建工单页面用于登记诉求',
          },
          {
            id: 'src_2',
            type: 'page',
            title: '派单处理',
            ref: 'https://example.com/dispatch',
            content: '公共左侧导航\n派单页面用于选择承办单位',
          },
          {
            id: 'src_3',
            type: 'page',
            title: '退单处理',
            ref: 'https://example.com/return',
            content: '公共左侧导航\n退单页面用于补充退单原因',
          },
        ],
        navigation: [],
        issues: [],
      }),
      applyDirectoryProposal: () => ({ store: {}, applied: {} }),
      applyFlowProposal: () => ({ store: {}, applied: {} }),
      model: async (_settings: unknown, messages: Array<{ content: string }>) => {
        prompt = messages.map((message) => message.content).join('\n');
        return {
          value: {
            message: 'ok',
            directories: [{ key: 'd1', parentKey: '', name: '工单受理', menuPath: ['工单受理'] }],
            functions: [
              {
                name: '新建工单',
                directoryKey: 'd1',
                purpose: '登记诉求',
                entry: 'https://example.com/new',
                menuPath: ['工单受理', '新建工单'],
                evidence: [{ sourceId: 'src_1', quote: '新建工单页面用于登记诉求' }],
              },
            ],
            warnings: [],
          },
          usage: {},
        };
      },
    });
    try {
      service.start(root, system, { phase: 'directory', message: '测试压缩' }, settings);
      await waitFor(service, root, 'awaiting_confirmation');
      assert.doesNotMatch(prompt, /公共左侧导航/);
      assert.match(prompt, /新建工单页面用于登记诉求/);
      assert.match(prompt, /派单页面用于选择承办单位/);
      assert.match(prompt, /退单页面用于补充退单原因/);
    } finally {
      service.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
